"use strict";

// Social Chamber: Mongo-backed friends plus pigeon messaging paid in septims.
// settings.vgrSocial keys:
//   enabled             set false to disable the extension entirely (default true)
//   databaseName        gamemode database holding friends/messages (default "vengeful_realms")
//   backendDatabaseName backend database holding character docs (default "skymp-backend")
//   friendsCollection   friends collection name (default "vgr_social_friends")
//   messagesCollection  messages collection name (default "vgr_social_messages")
//   maxFriends          accepted friends cap per player (default 12, min 1)
//   maxPendingRequests  combined pending incoming+outgoing cap per player (default 10, min 1)
//   maxMessageLength    pigeon text length cap in characters (default 250, min 1)
//   actionCooldownMs    per-profile cooldown between social actions (default 750, min 250)
//   pigeonRoutes        array of { maxDistance, cost, delaySeconds } route bands; null or
//                       missing maxDistance means unbounded; any invalid entry rejects the
//                       whole list and the built-in defaults are used instead
//   databaseUri         explicit Mongo URI for the gamemode database (default derived from settings.databaseUri)
//   backendDatabaseUri  explicit Mongo URI for the backend database (default derived from settings.databaseUri)

module.exports = (mp) => {
  const LOG = "[VGR social]";
  const helpers = require("./vgr_helpers");
  const identity = require("./vgr_access_identity");
  const crypto = require("crypto");
  const fs = require("fs");
  const path = require("path");

  let settings = {};
  try {
    settings = mp.getServerSettings ? mp.getServerSettings() : {};
  } catch (e) {
    console.error(LOG, "failed to read server settings:", e && e.message ? e.message : e);
  }

  const config = settings.vgrSocial || {};
  if (config.enabled === false) {
    console.info(LOG, "extension disabled by vgrSocial.enabled=false");
    return;
  }

  const DB_NAME = config.databaseName || "vengeful_realms";
  const BACKEND_DB_NAME = config.backendDatabaseName || "skymp-backend";
  const FRIENDS_COLLECTION = config.friendsCollection || "vgr_social_friends";
  const MESSAGES_COLLECTION = config.messagesCollection || "vgr_social_messages";
  const MAX_FRIENDS = Math.max(1, Math.floor(Number(config.maxFriends) || 12));
  const MAX_PENDING_REQUESTS = Math.max(1, Math.floor(Number(config.maxPendingRequests) || 10));
  const MAX_MESSAGE_LENGTH = Math.max(1, Math.floor(Number(config.maxMessageLength) || 250));
  const ACTION_COOLDOWN_MS = Math.max(250, Number(config.actionCooldownMs) || 750);

  // Distances are Skyrim world units; Whiterun to Solitude is roughly 141000.
  const DEFAULT_PIGEON_BANDS = [
    { maxDistance: 25000, cost: 2, delayMs: 30000 },
    { maxDistance: 75000, cost: 5, delayMs: 60000 },
    { maxDistance: 160000, cost: 10, delayMs: 120000 },
    { maxDistance: Infinity, cost: 15, delayMs: 180000 },
  ];

  // Validates settings.vgrSocial.pigeonRoutes; any bad entry rejects the whole list.
  function normalizedPigeonRoutes(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    const bands = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") return null;
      const maxDistance = entry.maxDistance == null ? Infinity : Number(entry.maxDistance);
      const cost = Number(entry.cost);
      const delaySeconds = Number(entry.delaySeconds);
      if (!(maxDistance > 0)) return null;
      if (!Number.isFinite(cost) || cost < 0) return null;
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) return null;
      bands.push({ maxDistance, cost: Math.floor(cost), delayMs: Math.round(delaySeconds * 1000) });
    }
    bands.sort((a, b) => a.maxDistance - b.maxDistance);
    return bands;
  }

  const PIGEON_BANDS = normalizedPigeonRoutes(config.pigeonRoutes) || DEFAULT_PIGEON_BANDS;
  if (Array.isArray(config.pigeonRoutes) && PIGEON_BANDS === DEFAULT_PIGEON_BANDS) {
    console.warn(LOG, "invalid vgrSocial.pigeonRoutes; using default route bands");
  }
  const UNKNOWN_DISTANCE_ROUTE = { cost: 10, delayMs: 120000 };

  let MongoClient = null;
  try {
    MongoClient = require("mongodb").MongoClient;
  } catch (e) {
    console.error(LOG, "MongoDB driver missing; Social Chamber will fail closed.");
  }

  const actors = helpers.playerInteractions.createActorHelpers(mp, {});
  const lastActionAt = new Map();
  const lastKnownLocation = new Map();
  const lastLocationWriteAt = new Map();
  const LOCATION_WRITE_INTERVAL_MS = 30000;
  let mongoClientPromise = null;
  let backendClientPromise = null;
  let indexPromise = null;
  let databaseReady = false;
  let deliveryTimer = null;
  let deliveryTimerAt = 0;

  // Pigeon charges and refunds append one line to trading.log (rotated by the server manager).
  const logDir = process.env.VGR_LOG_DIR || settings.logDir || "C:\\logs";
  const socialAudit = (line) => {
    try { fs.appendFile(path.join(logDir, "trading.log"), new Date().toISOString() + " " + line + "\n", () => {}); }
    catch (e) { }
  };

  function deriveMongoUri(dbName, explicitUri) {
    if (explicitUri) return explicitUri;
    if (!settings.databaseUri) return "";
    try {
      const uri = new URL(settings.databaseUri);
      uri.pathname = "/" + dbName;
      return uri.toString();
    } catch (e) {
      console.error(LOG, "invalid databaseUri:", e && e.message ? e.message : e);
      return "";
    }
  }

  const MONGO_URI = deriveMongoUri(DB_NAME, config.databaseUri);
  const BACKEND_URI = deriveMongoUri(BACKEND_DB_NAME, config.backendDatabaseUri);

  function getDb() {
    if (!MongoClient) return Promise.reject(new Error("MongoDB driver is not installed"));
    if (!MONGO_URI) return Promise.reject(new Error("No MongoDB URI configured for Social Chamber"));
    if (!mongoClientPromise) mongoClientPromise = MongoClient.connect(MONGO_URI, { maxPoolSize: 6 });
    return mongoClientPromise.then((client) => client.db(DB_NAME));
  }

  function getBackendDb() {
    if (!MongoClient) return Promise.reject(new Error("MongoDB driver is not installed"));
    if (!BACKEND_URI) return Promise.reject(new Error("No MongoDB URI configured for Social character data"));
    if (!backendClientPromise) backendClientPromise = MongoClient.connect(BACKEND_URI, { maxPoolSize: 4 });
    return backendClientPromise.then((client) => client.db(BACKEND_DB_NAME));
  }

  // Unique dedup index only over string nonces; docs without a nonce omit the field.
  async function ensureNonceIndex(messages) {
    const keys = { fromProfileId: 1, clientNonce: 1 };
    const options = { name: "clientNonce_dedup", unique: true, partialFilterExpression: { clientNonce: { $type: "string" } } };
    try {
      await messages.createIndex(keys, options);
    } catch (e) {
      const conflict = e && (e.code === 85 || e.code === 86 || e.codeName === "IndexOptionsConflict" || e.codeName === "IndexKeySpecsConflict");
      if (!conflict) throw e;
      // Replace a legacy sparse index left behind by the pre-integration module.
      await messages.dropIndex("fromProfileId_1_clientNonce_1").catch(() => {});
      await messages.createIndex(keys, options);
    }
  }

  async function getCollections() {
    const db = await getDb();
    const backendDb = await getBackendDb();
    const friends = db.collection(FRIENDS_COLLECTION);
    const messages = db.collection(MESSAGES_COLLECTION);
    const characters = backendDb.collection("characters");

    if (!indexPromise) {
      indexPromise = Promise.all([
        friends.createIndex({ aProfileId: 1, bProfileId: 1 }, { unique: true }),
        friends.createIndex({ aProfileId: 1, status: 1 }),
        friends.createIndex({ bProfileId: 1, status: 1 }),
        messages.createIndex({ messageId: 1 }, { unique: true }),
        ensureNonceIndex(messages),
        messages.createIndex({ fromProfileId: 1, toProfileId: 1, sentAt: -1 }),
        messages.createIndex({ toProfileId: 1, status: 1, deliverAt: 1 }),
        characters.createIndex({ name: 1, deletedAt: 1 }),
      ]);
    }

    await indexPromise;
    return { friends, messages, characters };
  }

  // Closes a stale client in the background so failed connects do not leak sockets.
  function discardClient(clientPromise) {
    if (!clientPromise) return;
    clientPromise.then((client) => client.close()).catch(() => {});
  }

  async function ensureDatabase() {
    try {
      await getCollections();
      databaseReady = true;
      armDeliveryTimer();
      return true;
    } catch (e) {
      databaseReady = false;
      discardClient(mongoClientPromise);
      discardClient(backendClientPromise);
      mongoClientPromise = null;
      backendClientPromise = null;
      indexPromise = null;
      console.error(LOG, "database unavailable:", e && e.message ? e.message : e);
      return false;
    }
  }

  function sendToActor(pcFormId, payload) {
    try {
      if (!actors.exists(pcFormId)) return false;
      mp.set(pcFormId, "vgrSocialUpdate", Object.assign({
        nonce: Date.now() + ":" + crypto.randomBytes(6).toString("hex"),
      }, payload));
      return true;
    } catch (e) {
      console.warn(LOG, "failed to send client packet:", e && e.message ? e.message : e);
      return false;
    }
  }

  function notify(pcFormId, message, level = "info") {
    sendToActor(pcFormId, { action: "notification", message: String(message || ""), level });
  }

  function parseProfileId(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function getIdentity(pcFormId) {
    return actors.identity(pcFormId) || identity.getIdentity(mp, pcFormId);
  }

  function getPair(left, right) {
    return Number(left) < Number(right)
      ? { aProfileId: Number(left), bProfileId: Number(right) }
      : { aProfileId: Number(right), bProfileId: Number(left) };
  }

  function cleanText(value, maxLength) {
    return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
  }

  // Shared per-profile cooldown for all player-initiated social actions.
  function cooldownBlocked(who) {
    const nowMs = Date.now();
    if (nowMs - (lastActionAt.get(who.profileId) || 0) < ACTION_COOLDOWN_MS) return true;
    lastActionAt.set(who.profileId, nowMs);
    return false;
  }

  function countAcceptedFriends(friends, profileId) {
    return friends.countDocuments({
      status: "accepted",
      $or: [{ aProfileId: Number(profileId) }, { bProfileId: Number(profileId) }],
    });
  }

  function normalizedPosition(value) {
    if (Array.isArray(value) && value.length >= 3) {
      const out = value.slice(0, 3).map(Number);
      return out.every(Number.isFinite) ? out : null;
    }
    if (value && typeof value === "object") {
      const out = [Number(value.x), Number(value.y), Number(value.z)];
      return out.every(Number.isFinite) ? out : null;
    }
    return null;
  }

  function actorLocation(pcFormId) {
    if (!pcFormId) return null;
    const position = normalizedPosition(actors.position(pcFormId));
    if (!position) return null;
    return {
      position,
      world: actors.cell(pcFormId),
      recordedAt: new Date(),
    };
  }

  // Best-effort socialLocation write so offline-target pricing survives restarts.
  function persistSocialLocation(who, location, force) {
    if (!who || !location || !databaseReady) return;
    const position = normalizedPosition(location.position);
    if (!position) return;
    const nowMs = Date.now();
    if (!force && nowMs - (lastLocationWriteAt.get(who.profileId) || 0) < LOCATION_WRITE_INTERVAL_MS) return;
    lastLocationWriteAt.set(who.profileId, nowMs);
    getCollections()
      .then(({ characters }) => characters.updateOne(
        { profileId: who.profileId, deletedAt: null },
        {
          $set: {
            socialLocation: {
              x: position[0],
              y: position[1],
              z: position[2],
              cell: String(location.world || ""),
              updatedAt: new Date(),
            },
          },
        }
      ))
      .catch((e) => console.warn(LOG, "socialLocation write failed:", e && e.message ? e.message : e));
  }

  function rememberLocation(pcFormId) {
    const who = getIdentity(pcFormId);
    const location = actorLocation(pcFormId);
    if (!who || !location) return null;
    lastKnownLocation.set(who.profileId, location);
    persistSocialLocation(who, location, false);
    return location;
  }

  function onlineActorsByProfile() {
    const out = new Map();
    for (const pcFormId of actors.onlinePlayers()) {
      const who = getIdentity(pcFormId);
      if (!who) continue;
      out.set(who.profileId, pcFormId);
      rememberLocation(pcFormId);
    }
    return out;
  }

  // Accepts live locations ({ position, world }) and stored socialLocation docs ({ x, y, z, cell }).
  function locationOf(value) {
    if (!value || typeof value !== "object") return null;
    const position = normalizedPosition(value.position != null ? value.position : value);
    if (!position) return null;
    return { position, world: String(value.world || value.cell || "") };
  }

  function routeFor(senderActor, targetProfileId, targetCharacter, onlineMap) {
    const sender = locationOf(actorLocation(senderActor));
    const targetActor = onlineMap.get(targetProfileId);
    const target = locationOf(
      targetActor
        ? actorLocation(targetActor)
        : lastKnownLocation.get(targetProfileId) || (targetCharacter && targetCharacter.socialLocation)
    );

    // Raw 3D distance only means anything inside one worldspace or cell.
    let distance = null;
    const sameSpace = sender && target && sender.world && target.world && sender.world === target.world;
    if (sameSpace) {
      const dx = sender.position[0] - target.position[0];
      const dy = sender.position[1] - target.position[1];
      const dz = sender.position[2] - target.position[2];
      distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const band = distance == null
      ? UNKNOWN_DISTANCE_ROUTE
      : PIGEON_BANDS.find((entry) => distance <= entry.maxDistance) || PIGEON_BANDS[PIGEON_BANDS.length - 1];

    return {
      distance: distance == null ? null : Math.round(distance),
      cost: band.cost,
      delayMs: band.delayMs,
    };
  }

  async function findCharacterByName(characters, rawName) {
    const name = cleanText(rawName, 40);
    if (!name) return { error: "Enter a hero name." };

    let matches = await characters.find(
      { deletedAt: null, permaDead: { $ne: true }, name },
      { projection: { profileId: 1, name: 1, displayName: 1, socialLocation: 1 } }
    ).limit(2).toArray();

    if (!matches.length) {
      matches = await characters.find(
        { deletedAt: null, permaDead: { $ne: true }, name },
        { projection: { profileId: 1, name: 1, displayName: 1, socialLocation: 1 }, collation: { locale: "en", strength: 2 } }
      ).limit(2).toArray();
    }

    if (!matches.length) return { error: "That hero could not be found." };
    if (matches.length > 1) return { error: "That hero name is not unique." };
    return { character: matches[0] };
  }

  function publicFriend(profileId, character, onlineMap) {
    return {
      id: String(profileId),
      formDesc: String(profileId),
      name: cleanText(character && (character.displayName || character.name), 40) || ("Profile " + profileId),
      status: onlineMap.has(profileId) ? "online" : "offline",
    };
  }

  async function loadSocial(pcFormId) {
    const who = getIdentity(pcFormId);
    if (!who || !(await ensureDatabase())) {
      notify(pcFormId, "Social Chamber is temporarily unavailable.", "error");
      return;
    }

    const { friends, characters } = await getCollections();
    const relations = await friends.find({
      $or: [{ aProfileId: who.profileId }, { bProfileId: who.profileId }],
    }).limit(200).toArray();
    const ids = relations
      .map((doc) => Number(doc.aProfileId) === who.profileId ? Number(doc.bProfileId) : Number(doc.aProfileId))
      .filter((id) => Number.isInteger(id));
    const characterDocs = ids.length
      ? await characters.find(
          { profileId: { $in: ids }, deletedAt: null, permaDead: { $ne: true } },
          { projection: { profileId: 1, name: 1, displayName: 1 } }
        ).toArray()
      : [];
    const byProfile = new Map(characterDocs.map((doc) => [Number(doc.profileId), doc]));
    const onlineMap = onlineActorsByProfile();
    const accepted = [];
    const incoming = [];
    const outgoing = [];

    for (const relation of relations) {
      const targetId = Number(relation.aProfileId) === who.profileId
        ? Number(relation.bProfileId)
        : Number(relation.aProfileId);
      const target = byProfile.get(targetId);
      if (!target) continue;
      const entry = publicFriend(targetId, target, onlineMap);
      if (relation.status === "accepted") accepted.push(entry);
      else if (relation.requestedBy === who.profileId) outgoing.push(entry);
      else incoming.push(entry);
    }

    sendToActor(pcFormId, {
      action: "friends",
      accepted,
      incoming,
      outgoing,
      maxFriends: MAX_FRIENDS,
      maxMessageLength: MAX_MESSAGE_LENGTH,
    });
  }

  async function pushSocialForProfile(profileId) {
    const actor = onlineActorsByProfile().get(Number(profileId));
    if (actor) await loadSocial(actor);
  }

  async function handleAddFriend(pcFormId, data) {
    const who = getIdentity(pcFormId);
    if (!who) return;
    if (actors.isDead(pcFormId)) return notify(pcFormId, "The dead cannot use the Social Chamber.", "warning");
    if (cooldownBlocked(who)) return notify(pcFormId, "Please wait a moment.", "warning");
    if (!(await ensureDatabase())) return notify(pcFormId, "Social Chamber is temporarily unavailable.", "error");

    const { friends, characters } = await getCollections();
    const found = await findCharacterByName(characters, data && data.name);
    if (found.error) return notify(pcFormId, found.error, "warning");

    const target = found.character;
    const targetId = Number(target.profileId);
    if (!Number.isInteger(targetId) || targetId === who.profileId) return notify(pcFormId, "You cannot add yourself.", "warning");

    const pair = getPair(who.profileId, targetId);
    const existing = await friends.findOne(pair);
    if (existing && existing.status === "accepted") return notify(pcFormId, "That player is already your friend.", "info");
    if (existing && existing.status === "pending" && existing.requestedBy !== who.profileId) {
      // Mutual add auto-accepts, but both sides must still have room.
      if ((await countAcceptedFriends(friends, who.profileId)) >= MAX_FRIENDS) return notify(pcFormId, "Your friends list is full.", "warning");
      if ((await countAcceptedFriends(friends, targetId)) >= MAX_FRIENDS) return notify(pcFormId, "That player's friends list is full.", "warning");
      await friends.updateOne(pair, { $set: { status: "accepted", updatedAt: new Date() } });
      await loadSocial(pcFormId);
      await pushSocialForProfile(targetId);
      return notify(pcFormId, "Friend request accepted.", "success");
    }

    const acceptedCount = await countAcceptedFriends(friends, who.profileId);
    if (acceptedCount >= MAX_FRIENDS) return notify(pcFormId, "Your friends list is full.", "warning");

    // Cap combined pending incoming and outgoing requests before creating a new one.
    if (!existing) {
      const pendingCount = await friends.countDocuments({
        status: "pending",
        $or: [{ aProfileId: who.profileId }, { bProfileId: who.profileId }],
      });
      if (pendingCount >= MAX_PENDING_REQUESTS) return notify(pcFormId, "You have too many pending friend requests.", "warning");
    }

    await friends.updateOne(
      pair,
      { $setOnInsert: { aProfileId: pair.aProfileId, bProfileId: pair.bProfileId, status: "pending", requestedBy: who.profileId, createdAt: new Date() }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    await loadSocial(pcFormId);
    await pushSocialForProfile(targetId);
    notify(pcFormId, "Friend request sent.", "success");
    const targetActor = onlineActorsByProfile().get(targetId);
    if (targetActor) notify(targetActor, who.displayName + " sent you a friend request.", "info");
  }

  async function handleFriendDecision(pcFormId, data, action) {
    const who = getIdentity(pcFormId);
    const targetId = parseProfileId(data && (data.formDesc || data.id));
    if (!who || targetId == null || targetId === who.profileId) return;
    if (actors.isDead(pcFormId)) return notify(pcFormId, "The dead cannot use the Social Chamber.", "warning");
    if (cooldownBlocked(who)) return notify(pcFormId, "Please wait a moment.", "warning");
    if (!(await ensureDatabase())) return;

    const { friends } = await getCollections();
    const pair = getPair(who.profileId, targetId);
    const relation = await friends.findOne(pair);
    if (!relation) return notify(pcFormId, "Friend request no longer exists.", "warning");

    if (action === "acceptFriend") {
      if (relation.status !== "pending" || relation.requestedBy === who.profileId) return notify(pcFormId, "That request cannot be accepted.", "warning");
      if ((await countAcceptedFriends(friends, who.profileId)) >= MAX_FRIENDS) return notify(pcFormId, "Your friends list is full.", "warning");
      if ((await countAcceptedFriends(friends, targetId)) >= MAX_FRIENDS) return notify(pcFormId, "That player's friends list is full.", "warning");
      await friends.updateOne(pair, { $set: { status: "accepted", updatedAt: new Date() } });
      notify(pcFormId, "Friend added.", "success");
    } else if (action === "declineFriend") {
      if (relation.status !== "pending") return;
      await friends.deleteOne(pair);
      notify(pcFormId, "Friend request removed.", "info");
    } else {
      if (relation.status !== "accepted") return;
      await friends.deleteOne(pair);
      notify(pcFormId, "Friend removed.", "info");
    }

    await loadSocial(pcFormId);
    await pushSocialForProfile(targetId);
  }

  function messageTime(value) {
    const time = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
    return Number.isFinite(time) ? time : Date.now();
  }

  function formatMessage(doc, profileId) {
    return {
      id: String(doc.messageId),
      text: String(doc.text || ""),
      sentByMe: Number(doc.fromProfileId) === Number(profileId),
      timestamp: messageTime(doc.sentAt),
      deliveryAt: messageTime(doc.deliverAt),
      status: String(doc.status || "delivered"),
    };
  }

  async function acceptedFriend(friends, left, right) {
    return friends.findOne(Object.assign(getPair(left, right), { status: "accepted" }));
  }

  async function handleLoadChat(pcFormId, data) {
    const who = getIdentity(pcFormId);
    const targetId = parseProfileId(data && (data.withFormDesc || data.id));
    if (!who || targetId == null) return;
    if (actors.isDead(pcFormId)) return notify(pcFormId, "The dead cannot use the Social Chamber.", "warning");
    if (cooldownBlocked(who)) return notify(pcFormId, "Please wait a moment.", "warning");
    if (!(await ensureDatabase())) return;

    const { friends, messages } = await getCollections();
    if (!(await acceptedFriend(friends, who.profileId, targetId))) return notify(pcFormId, "Pigeons can only be sent to friends.", "warning");

    const docs = await messages.find({
      $or: [
        { fromProfileId: who.profileId, toProfileId: targetId, status: { $in: ["queued", "delivered"] } },
        { fromProfileId: targetId, toProfileId: who.profileId, status: "delivered" },
      ],
    }).sort({ sentAt: -1 }).limit(100).toArray();

    // Opening the chat marks delivered pigeons from this friend as read.
    await messages.updateMany(
      { fromProfileId: targetId, toProfileId: who.profileId, status: "delivered", readAt: null },
      { $set: { readAt: new Date() } }
    );

    sendToActor(pcFormId, {
      action: "chatHistory",
      withFormDesc: String(targetId),
      messages: docs.reverse().map((doc) => formatMessage(doc, who.profileId)),
    });
  }

  async function handleSendMessage(pcFormId, data) {
    const who = getIdentity(pcFormId);
    const targetId = parseProfileId(data && (data.toFormDesc || data.id));
    const text = cleanText(data && data.text, MAX_MESSAGE_LENGTH);
    if (!who || targetId == null || !text) return;
    if (actors.isDead(pcFormId)) return notify(pcFormId, "The dead cannot send pigeons.", "warning");
    if (cooldownBlocked(who)) return notify(pcFormId, "Please wait before sending another pigeon.", "warning");
    if (!(await ensureDatabase())) return notify(pcFormId, "Pigeon service is temporarily unavailable.", "error");

    const { friends, messages, characters } = await getCollections();
    if (!(await acceptedFriend(friends, who.profileId, targetId))) return notify(pcFormId, "Pigeons can only be sent to friends.", "warning");

    const clientNonce = cleanText(data && data.clientNonce, 80);
    if (clientNonce) {
      const prior = await messages.findOne({ fromProfileId: who.profileId, clientNonce });
      if (prior) {
        sendToActor(pcFormId, {
          action: "incomingMessage",
          fromFormDesc: String(who.profileId),
          toFormDesc: String(targetId),
          text: prior.text,
          sentByMe: true,
          timestamp: messageTime(prior.sentAt),
          deliveryAt: messageTime(prior.deliverAt),
          status: prior.status,
        });
        return;
      }
    }

    const senderCharacter = await characters.findOne({ profileId: who.profileId, deletedAt: null }, { projection: { profileId: 1 } });
    const targetCharacter = await characters.findOne(
      { profileId: targetId, deletedAt: null, permaDead: { $ne: true } },
      { projection: { profileId: 1, name: 1, displayName: 1, socialLocation: 1 } }
    );
    if (!senderCharacter || !targetCharacter) return notify(pcFormId, "That character is unavailable.", "warning");

    const onlineMap = onlineActorsByProfile();
    const route = routeFor(pcFormId, targetId, targetCharacter, onlineMap);
    const balanceUpdate = await characters.updateOne(
      { profileId: who.profileId, deletedAt: null, $expr: { $gte: [{ $ifNull: ["$balance", 0] }, route.cost] } },
      { $inc: { balance: -route.cost }, $set: { updatedAt: new Date() } }
    );
    if (!balanceUpdate.matchedCount) return notify(pcFormId, "You do not have enough septims.", "warning");

    const targetName = cleanText(targetCharacter.displayName || targetCharacter.name, 40) || ("Profile " + targetId);
    socialAudit(
      "[pigeon] " + who.displayName + " (profile " + who.profileId + ") paid " + route.cost +
      " septims -> " + targetName + " (profile " + targetId + "), delivery in " + Math.round(route.delayMs / 1000) + "s"
    );

    const sentAt = new Date();
    const deliverAt = new Date(sentAt.getTime() + route.delayMs);
    const message = {
      messageId: crypto.randomBytes(12).toString("hex"),
      fromProfileId: who.profileId,
      fromName: who.displayName || "",
      toProfileId: targetId,
      text,
      cost: route.cost,
      distance: route.distance,
      sentAt,
      deliverAt,
      status: "queued",
      readAt: null,
    };
    if (clientNonce) message.clientNonce = clientNonce;

    try {
      await messages.insertOne(message);
    } catch (e) {
      await characters.updateOne({ profileId: who.profileId, deletedAt: null }, { $inc: { balance: route.cost } });
      socialAudit(
        "[pigeon] refunded " + route.cost + " septims to " + who.displayName + " (profile " + who.profileId +
        "), pigeon to " + targetName + " (profile " + targetId + ") not sent"
      );
      throw e;
    }

    sendToActor(pcFormId, {
      action: "incomingMessage",
      fromFormDesc: String(who.profileId),
      toFormDesc: String(targetId),
      text,
      sentByMe: true,
      timestamp: sentAt.getTime(),
      deliveryAt: deliverAt.getTime(),
      status: "queued",
    });
    notify(pcFormId, "Pigeon sent for " + route.cost + " " + (route.cost === 1 ? "septim" : "septims") + ". Delivery in " + Math.ceil(route.delayMs / 60000) + " min.", "success");
    scheduleDeliveryAt(deliverAt.getTime());
  }

  async function deliverDueMessages() {
    if (!databaseReady) return;
    const { messages } = await getCollections();
    const now = new Date();
    const due = await messages.find({ status: "queued", deliverAt: { $lte: now } }).sort({ deliverAt: 1 }).limit(100).toArray();
    if (!due.length) return;

    const onlineMap = onlineActorsByProfile();
    for (const message of due) {
      const result = await messages.updateOne(
        { messageId: message.messageId, status: "queued" },
        { $set: { status: "delivered", deliveredAt: now } }
      );
      if (!result.modifiedCount) continue;

      const targetActor = onlineMap.get(Number(message.toProfileId));
      if (targetActor) {
        sendToActor(targetActor, {
          action: "incomingMessage",
          fromFormDesc: String(message.fromProfileId),
          fromName: message.fromName || "",
          toFormDesc: String(message.toProfileId),
          text: message.text,
          sentByMe: false,
          timestamp: messageTime(message.sentAt),
          deliveryAt: messageTime(message.deliverAt),
          status: "delivered",
        });
      }
    }
  }

  function scheduleDeliveryAt(timestamp) {
    if (!databaseReady) return;
    const at = Number(timestamp);
    if (!Number.isFinite(at)) return;
    if (deliveryTimer && deliveryTimerAt <= at) return;
    if (deliveryTimer) clearTimeout(deliveryTimer);
    deliveryTimerAt = at;
    deliveryTimer = setTimeout(async () => {
      deliveryTimer = null;
      deliveryTimerAt = 0;
      try { await deliverDueMessages(); } catch (e) { console.error(LOG, "delivery sweep failed:", e && e.message ? e.message : e); }
      armDeliveryTimer();
    }, Math.min(Math.max(25, at - Date.now()), 0x7ffffffe));
  }

  async function armDeliveryTimer() {
    if (!databaseReady || deliveryTimer) return;
    try {
      const { messages } = await getCollections();
      const next = await messages.findOne({ status: "queued" }, { projection: { deliverAt: 1 }, sort: { deliverAt: 1 } });
      if (next && next.deliverAt) scheduleDeliveryAt(messageTime(next.deliverAt));
    } catch (e) {
      console.warn(LOG, "could not arm delivery scheduler:", e && e.message ? e.message : e);
    }
  }

  // Reconnect ping: delivered pigeons stay unread until the chat is opened.
  async function announceUnreadMessages(pcFormId) {
    const who = getIdentity(pcFormId);
    if (!who || !(await ensureDatabase())) return;
    const { messages } = await getCollections();
    const count = await messages.countDocuments({ toProfileId: who.profileId, status: "delivered", readAt: null });
    if (count > 0) notify(pcFormId, "(" + count + ") unread pigeon message(s) await you.", "info");
  }

  async function handleSocialEvent(pcFormId, event) {
    const kind = event && event.kind;
    const data = event && event.data || {};
    try {
      if (kind === "load") return await loadSocial(pcFormId);
      if (kind === "addFriend") return await handleAddFriend(pcFormId, data);
      if (kind === "removeFriend") return await handleFriendDecision(pcFormId, data, "removeFriend");
      if (kind === "acceptFriend") return await handleFriendDecision(pcFormId, data, "acceptFriend");
      if (kind === "declineFriend") return await handleFriendDecision(pcFormId, data, "declineFriend");
      if (kind === "loadChat") return await handleLoadChat(pcFormId, data);
      if (kind === "sendMessage") return await handleSendMessage(pcFormId, data);
    } catch (e) {
      console.error(LOG, "event failed:", kind, e && e.stack ? e.stack : e);
      if (kind === "sendMessage") notify(pcFormId, "The pigeon could not be sent.", "error");
      else notify(pcFormId, "Social service could not complete that action.", "error");
    }
  }

  mp.makeProperty("vgrSocialUpdate", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      const value = ctx.value;
      if (!value || !value.action) return;
      if (!ctx.state.vgrSocial) ctx.state.vgrSocial = { lastNonce: null };
      if (ctx.state.vgrSocial.lastNonce === value.nonce) return;
      ctx.state.vgrSocial.lastNonce = value.nonce;
      ctx.sp.browser.executeJavaScript("window.vgrSocialUpdate && window.vgrSocialUpdate(" + JSON.stringify(value) + ");");
    `,
    updateNeighbor: "",
  });

  mp.makeEventSource("_vgrSocial", `
    ctx.sp.on("browserMessage", (e) => {
      const msg = e.arguments && e.arguments[0];
      if (typeof msg !== "string" || !msg.startsWith("vgr:social:")) return;
      ctx.sendEvent({ kind: msg.slice("vgr:social:".length), data: e.arguments && e.arguments[1] });
    });
  `);

  mp._vgrSocial = (pcFormId, event) => {
    handleSocialEvent(pcFormId, event).catch((e) => {
      console.error(LOG, "event dispatch failed:", e && e.stack ? e.stack : e);
    });
  };

  // Connect and disconnect callbacks receive the user id, not the actor form id.
  mp.on("connect", (userId) => {
    try {
      const pcFormId = actors.actorFromUser(userId);
      if (!pcFormId) return;
      rememberLocation(pcFormId);
      announceUnreadMessages(pcFormId).catch((e) => {
        console.warn(LOG, "unread ping failed:", e && e.message ? e.message : e);
      });
    } catch (e) {}
  });

  mp.on("disconnect", (userId) => {
    try {
      const pcFormId = actors.actorFromUser(userId);
      if (pcFormId) {
        const who = getIdentity(pcFormId);
        if (who) {
          const location = actorLocation(pcFormId) || lastKnownLocation.get(who.profileId) || null;
          persistSocialLocation(who, location, true);
          lastActionAt.delete(who.profileId);
          lastKnownLocation.delete(who.profileId);
          lastLocationWriteAt.delete(who.profileId);
        }
        actors.forgetActor(pcFormId);
      }
    } catch (e) {
    } finally {
      actors.forgetUser(userId);
    }
  });

  ensureDatabase();
  console.info(LOG, "module loaded; Mongo-backed friends and single-timer pigeon delivery enabled");
};
