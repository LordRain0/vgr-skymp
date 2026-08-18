const DEFAULT_PREVIEW_IMAGE = "assets/portrait-template.png";

const EMOTE_GROUPS = [
    {
        id: "greetings",
        label: "Greetings",
        emotes: [
            { id: "0003EA32", label: "Wave", animationString: "IdleWave", previewImage: "assets/emotes/IdleWave.gif" },
            { id: "000F7C8C", label: "War Cheer", animationString: "IdleCivilWarCheer", previewImage: "assets/emotes/IdleCivilWarCheer.gif" },
            { id: "000B240C", label: "Salute", animationString: "IdleSalute", previewImage: "assets/emotes/IdleSalute.gif" },
            { id: "000D8734", label: "Silent Bow", animationString: "IdleSilentBow", previewImage: "assets/emotes/IdleSilentBow.gif" },
            { id: "0006FF15", label: "Get Attention", animationString: "IdleGetAttention", previewImage: "assets/emotes/IdleGetAttention.gif" },
            { id: "00075C62", label: "Look Far", animationString: "IdleLookFar", previewImage: "assets/emotes/IdleLookFar.gif" },
            { id: "000ABEF2", label: "Knock Door", animationString: "IdleMT_DoorBang", previewImage: "assets/emotes/IdleMT_DoorBang.gif" }
        ]
    },
    {
        id: "reactions",
        label: "Reactions",
        emotes: [
            { id: "000D8730", label: "Clapping", animationString: "IdleApplaud2", previewImage: "assets/emotes/IdleApplaud2.gif" },
            { id: "000D8732", label: "Applaud", animationString: "IdleApplaud4", previewImage: "assets/emotes/IdleApplaud4.gif" },
            { id: "000D8733", label: "Clapping Overhead", animationString: "IdleApplaud5", previewImage: "assets/emotes/IdleApplaud5.gif" },
            { id: "00075C5F", label: "Laugh", animationString: "IdleLaugh", previewImage: "assets/emotes/IdleLaugh.gif" },
            { id: "00105D47", label: "Surrender", animationString: "IdleSurrender", previewImage: "assets/emotes/IdleSurrender.gif" },
            { id: "000EF94C", label: "Scared", animationString: "IdleCowerEnter", previewImage: "assets/emotes/IdleCowerEnter.gif" },
            { id: "000977EC", label: "Wipe Brow", animationString: "IdleWipeBrow", previewImage: "assets/emotes/IdleWipeBrow.gif" },
            { id: "000B8F1A", label: "Wounded", animationString: "IdleWounded_02", previewImage: "assets/emotes/IdleWounded_02.gif" }
        ]
    },
    {
        id: "stances",
        label: "Stances",
        emotes: [
            { id: "00042E63", label: "Lay Down", animationString: "IdleLayDown", previewImage: "assets/emotes/IdleLayDown.gif" },
            { id: "000E8642", label: "Warm Hands", animationString: "IdleWarmHandsStanding", previewImage: "assets/emotes/IdleWarmHandsStanding.gif" },
            { id: "000E8643", label: "Warm Hands (Sit)", animationString: "IdleWarmHandsCrouched", previewImage: "assets/emotes/IdleWarmHandsCrouched.gif" },
            //{ id: "000F11E4", label: "Crouched Pray", animationString: "IdleCrouchedPray" },
            { id: "000977EF", label: "Pray", animationString: "IdleGrave_01", previewImage: "assets/emotes/IdleGrave_01.gif" },
            { id: "0006F300", label: "Worship", animationString: "IdlePray", previewImage: "assets/emotes/IdlePray.gif" },
            { id: "000C4EF9", label: "Sit Crossed", animationString: "IdleSitCrossLeggedEnter", previewImage: "assets/emotes/IdleSitCrossLeggedEnter.gif" },
            { id: "000E8E52", label: "Kneel", animationString: "IdleKneelingEnter", previewImage: "assets/emotes/IdleKneelingEnter.gif" },
            { id: "000B8F1B", label: "Sit Lazy", animationString: "IdleWounded_03", previewImage: "assets/emotes/IdleWounded_03.gif" }
        ]
    },    
    {
        id: "dialog",
        label: "Dialog",
        emotes: [
            { id: "000FF7F4", label: "Crossed Arms", animationString: "OffsetArmsCrossedStart", previewImage: "assets/emotes/OffsetArmsCrossedStart.gif" },
            { id: "000977F0", label: "Formal Stand", animationString: "IdleGrave_02", previewImage: "assets/emotes/IdleGrave_02.gif" },
            { id: "000B240A", label: "Hands Behind", animationString: "IdleHandsBehindBack", previewImage: "assets/emotes/IdleHandsBehindBack.gif" },
            { id: "00075C3D", label: "Examine", animationString: "IdleExamine", previewImage: "assets/emotes/IdleExamine.gif" },
            { id: "000977ED", label: "Study", animationString: "IdleStudy", previewImage: "assets/emotes/IdleStudy.gif" },
            { id: "0200D287", label: "Hand On Chin", animationString: "IdleDialogueHandOnChinGesture", previewImage: "assets/emotes/IdleDialogueHandOnChinGesture.gif" },
            { id: "000B8F1E", label: "Point Far", animationString: "IdlePointFar_01", previewImage: "assets/emotes/IdlePointFar_01.gif" }
        ]
    },
    {
        id: "activities",
        label: "Activities",
        emotes: [
            { id: "000FD68B", label: "Drink", animationString: "IdleDrink", previewImage: "assets/emotes/IdleDrink.gif" },
            { id: "00064100", label: "Eating", animationString: "IdleEatingStandingStart", previewImage: "assets/emotes/IdleEatingStandingStart.gif" },
            { id: "000640FE", label: "Sweeping", animationString: "IdleLooseSweepingStart", previewImage: "assets/emotes/IdleLooseSweepingStart.gif" },
            { id: "00075CB4", label: "Use Hoe", animationString: "IdleHoe", previewImage: "assets/emotes/IdleHoe.gif" },
            { id: "000F1AA0", label: "Ritual", animationString: "IdleRitualStart", previewImage: "assets/emotes/IdleRitualStart.gif" },
            { id: "00089975", label: "Read Note", animationString: "IdleNoteRead", previewImage: "assets/emotes/IdleNoteRead.gif" },
            { id: "0010DDBF", label: "Read Book", animationString: "IdleBook_PageTurn", previewImage: "assets/emotes/IdleBook_PageTurn.gif" }
        ]
    },
    {
        id: "entertainment",
        label: "Entertain",
        emotes: [
            { id: "000F7C8A", label: "Cicero Dance 1", animationString: "IdleCiceroDance1", previewImage: "assets/emotes/IdleCiceroDance1.gif" },
            { id: "000F7C8B", label: "Cicero Dance 2", animationString: "IdleCiceroDance2", previewImage: "assets/emotes/IdleCiceroDance2.gif" },
            { id: "00103653", label: "Cicero Dance 3", animationString: "IdleCiceroDance3", previewImage: "assets/emotes/IdleCiceroDance3.gif" },
            { id: "00096F8B", label: "Play Drum", animationString: "IdleDrumStart", previewImage: "assets/emotes/IdleDrumStart.gif" },
            { id: "00096F8C", label: "Play Flute", animationString: "IdleFluteStart", previewImage: "assets/emotes/IdleFluteStart.gif" },
            { id: "00096F8D", label: "Play Lute", animationString: "IdleLuteStart", previewImage: "assets/emotes/IdleLuteStart.gif" },
            { id: "000F6CCE", label: "Horn (Imper.)", animationString: "IdleBlowHornImperial", previewImage: "assets/emotes/IdleBlowHornImperial.gif" },
            { id: "000F6CCD", label: "Horn (Stormcl.)", animationString: "IdleBlowHornStormcloak", previewImage: "assets/emotes/IdleBlowHornStormcloak.gif" }
        ]
    }
];

let activeCategoryId = "greetings";
let activeEmoteId = "0003EA32";
let previewedEmoteId = "0003EA32";

const overlay = document.getElementById("emoteWheelOverlay");
const svg = document.getElementById("emoteWheelSvg");
const centerCategory = document.getElementById("centerCategory");
const centerEmote = document.getElementById("centerEmote");
const previewName = document.getElementById("previewName");
const previewImage = document.getElementById("previewImage");
const previewFrame = document.querySelector(".preview-image-frame");


window.addEventListener('vgr:ui_manager:open:emote', (event) => {
    if (!overlay) return;
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    renderAll();
});

window.addEventListener('vgr:ui_manager:close:emote', (event) => {
    if (!overlay) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
});


function selectCategory(categoryId) {
    const category = getCategory(categoryId);
    if (!category) return;

    activeCategoryId = categoryId;
    const firstEmote = category.emotes[0];
    activeEmoteId = firstEmote.id;
    previewedEmoteId = firstEmote.id;
    renderAll();
}

function selectEmote(emoteId) {
    const emote = getEmote(emoteId);
    if (!emote) return;

    activeEmoteId = emoteId;
    previewedEmoteId = emoteId;
    updatePreview(emoteId);
    renderWheel();
    triggerEmote(emoteId);
}

function getAnimationStringById(emoteId) {
    for (const group of EMOTE_GROUPS) {
        for (const emote of group.emotes) {
            if (emote.id === emoteId) {
                return emote.animationString;
            }
        }
    }
    return null; // or return undefined if not found
}

function triggerEmote(emoteId) {
    console.log("Sending FormID to server:", emoteId);
	/*
    if (window.jse && window.jse.send) {
        window.jse.send("vgr:emotes:play", emoteId);
    }*/
	
	window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "emote");
	window.skyrimPlatform?.sendMessage?.("vgr:emotes:play", emoteId, getAnimationStringById(emoteId) );
}

function renderAll() {
    renderWheel();
    updatePreview(previewedEmoteId);
}

function renderWheel() {
    const category = getCategory(activeCategoryId);
    if (!category || !svg) return;

    svg.innerHTML = "";
    if (centerCategory) centerCategory.textContent = category.label.toUpperCase();

    const activeOrPreview = getEmote(previewedEmoteId) || category.emotes[0];
    if (centerEmote) centerEmote.textContent = activeOrPreview.label;

    const center = 410;
    const categoryInner = 155;
    const categoryOuter = 238;
    const emoteInner = 252;
    const emoteOuter = 390;

    drawRing({
        items: EMOTE_GROUPS,
        innerRadius: categoryInner,
        outerRadius: categoryOuter,
        center,
        className: "category-segment",
        labelClass: "segment-label-small",
        activeId: activeCategoryId,
        //onHover: (item) => selectCategory(item.id),
        onClick: (item) => selectCategory(item.id),
        labelResolver: (item) => item.label
    });

    drawRing({
        items: category.emotes,
        innerRadius: emoteInner,
        outerRadius: emoteOuter,
        center,
        className: "emote-segment",
        labelClass: "segment-label",
        activeId: activeEmoteId,
        onHover: (item) => previewEmote(item.id),
        onClick: (item) => selectEmote(item.id),
        labelResolver: (item) => item.label
    });
}

function drawRing(config) {
    const { items, innerRadius, outerRadius, center, className, labelClass, activeId, onHover, onClick, labelResolver } = config;
    const gap = 1.1;
    const step = 360 / items.length;
    const startOffset = -90;

    items.forEach((item, index) => {
        const startAngle = startOffset + index * step + gap;
        const endAngle = startOffset + (index + 1) * step - gap;
        const midAngle = (startAngle + endAngle) / 2;
        const pathData = describeArcSegment(center, center, innerRadius, outerRadius, startAngle, endAngle);

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData);
        path.setAttribute("class", `segment ${className} ${item.id === activeId ? "active" : ""}`);
		// Only add hover if onHover function is provided
        if (onHover) {
            path.addEventListener("mouseenter", () => onHover(item));
        }
        path.addEventListener("click", () => onClick(item));
        svg.appendChild(path);

        const labelRadius = innerRadius + (outerRadius - innerRadius) * 0.55;
        const labelPoint = polarToCartesian(center, center, labelRadius, midAngle);
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", labelPoint.x);
        label.setAttribute("y", labelPoint.y);
        label.setAttribute("class", labelClass);
        label.textContent = shortenLabel(labelResolver(item));
        svg.appendChild(label);
    });
}

function previewEmote(emoteId) {
    const emote = getEmote(emoteId);
    if (!emote) return;

    previewedEmoteId = emoteId;
    if (centerEmote) centerEmote.textContent = emote.label;
    updatePreview(emoteId);
}

function updatePreview(emoteId) {
    const emote = getEmote(emoteId);
    const category = getCategoryByEmote(emoteId);
    if (!emote || !category) return;

    if (previewName) previewName.textContent = emote.label;
    if (centerCategory) centerCategory.textContent = category.label.toUpperCase();
    if (centerEmote) centerEmote.textContent = emote.label;

    const nextImage = emote.previewImage || DEFAULT_PREVIEW_IMAGE;
    if (previewImage && previewImage.getAttribute("src") !== nextImage) {
        if (previewFrame) previewFrame.classList.add("preview-change");
        setTimeout(() => {
            if (previewImage) previewImage.setAttribute("src", nextImage);
            if (previewFrame) previewFrame.classList.remove("preview-change");
        }, 120);
    }
}

function getCategory(categoryId) {
    return EMOTE_GROUPS.find((category) => category.id === categoryId);
}

function getEmote(emoteId) {
    for (const category of EMOTE_GROUPS) {
        const emote = category.emotes.find((item) => item.id === emoteId);
        if (emote) return emote;
    }
    return null;
}

function getCategoryByEmote(emoteId) {
    return EMOTE_GROUPS.find((category) => category.emotes.some((item) => item.id === emoteId));
}

function shortenLabel(label) {
    if (label.length <= 15) return label;
    return label
        .replace(" Hands ", " H. ")
        .replace("Attention", "Attn")
        .replace("Crossed", "Cross")
        .replace("Sitting", "Sit");
}

function describeArcSegment(cx, cy, innerRadius, outerRadius, startAngle, endAngle) {
    const outerStart = polarToCartesian(cx, cy, outerRadius, endAngle);
    const outerEnd = polarToCartesian(cx, cy, outerRadius, startAngle);
    const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
    const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

    return [
        "M", outerStart.x, outerStart.y,
        "A", outerRadius, outerRadius, 0, largeArcFlag, 0, outerEnd.x, outerEnd.y,
        "L", innerStart.x, innerStart.y,
        "A", innerRadius, innerRadius, 0, largeArcFlag, 1, innerEnd.x, innerEnd.y,
        "Z"
    ].join(" ");
}

function polarToCartesian(cx, cy, radius, angleInDegrees) {
    const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
    return {
        x: cx + radius * Math.cos(angleInRadians),
        y: cy + radius * Math.sin(angleInRadians)
    };
}


window.addEventListener("contextmenu", (event) => {
    if (overlay && !overlay.classList.contains("hidden")) {
        event.preventDefault();
		window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "emote");
    }
});

renderAll();
