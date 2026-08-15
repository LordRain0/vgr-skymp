#include "ScampServer.h"

#include "Appearance.h"
#include "MpChangeForms.h"
#include <database_drivers/DatabaseFactory.h>
#include <libespm/Loader.h>
#include <libespm/RecordHeader.h>
#include <libespm/Utils.h>
#include <spdlog/sinks/stdout_color_sinks.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <iomanip>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

constexpr size_t kNoPlugin = std::numeric_limits<size_t>::max();
constexpr uint32_t kFullIndexMask = 0xff000000;
constexpr uint32_t kFullShortFormIdMask = 0x00ffffff;
constexpr uint32_t kLightPrefix = 0xfe000000;
constexpr uint32_t kLightIndexMask = 0x00000fff;
constexpr uint32_t kExampleLimit = 20;
constexpr size_t kMigrationChunkSize = 1000;

using ChangeFormDatabase =
  Viet::IDatabase<MpChangeForm, FormDesc, std::vector<FormDesc>>;

struct PluginSnapshot
{
  std::string filename;
  std::string key;
  int64_t crc32 = 0;
  uint64_t size = 0;
  bool isLight = false;
  std::optional<uint16_t> fullIndex;
  std::optional<uint16_t> lightIndex;
};

struct SnapshotIndex
{
  std::vector<PluginSnapshot> plugins;
  std::unordered_map<std::string, size_t> byName;
  std::vector<size_t> fullByIndex;
  std::vector<size_t> lightByIndex;
  std::vector<uint8_t> stableFullByIndex;
  std::vector<uint8_t> stableLightByIndex;
};

struct FieldStats
{
  size_t skipped = 0;
  size_t stableMappingSkipped = 0;
  size_t checked = 0;
  size_t unchanged = 0;
  size_t migratable = 0;
  size_t missingPlugin = 0;
  size_t invalidSlot = 0;
  size_t cannotEncode = 0;
  size_t recordMissing = 0;
  size_t recordTypeMismatch = 0;
};

struct DescriptorFieldStats
{
  size_t skipped = 0;
  size_t checked = 0;
  size_t unchanged = 0;
  size_t renamed = 0;
  size_t missingPlugin = 0;
  size_t ambiguousRename = 0;
};

struct DescriptorRename
{
  std::string oldFilename;
  std::string oldKey;
  std::string newFilename;
  std::string reason;
};

struct DescriptorRenamePlan
{
  std::unordered_map<std::string, DescriptorRename> byOldKey;
  std::map<std::string, std::vector<std::string>> ambiguousByOldKey;
};

struct PreflightStats
{
  size_t changeFormsScanned = 0;
  size_t affectedChangeForms = 0;
  size_t missingPluginChangeForms = 0;
  size_t actorWorldOrCellFallbackCandidates = 0;
  size_t skippedReferences = 0;
  size_t stableMappingSkippedReferences = 0;
  size_t checkedReferences = 0;
  size_t unchangedReferences = 0;
  size_t migratableReferences = 0;
  size_t missingPluginReferences = 0;
  size_t invalidSlotReferences = 0;
  size_t cannotEncodeReferences = 0;
  size_t recordMissingReferences = 0;
  size_t recordTypeMismatchReferences = 0;
  size_t descriptorSkippedReferences = 0;
  size_t descriptorCheckedReferences = 0;
  size_t descriptorUnchangedReferences = 0;
  size_t descriptorRenameReferences = 0;
  size_t descriptorMissingPluginReferences = 0;
  size_t descriptorAmbiguousRenameReferences = 0;
  size_t appearanceParseErrors = 0;
  std::map<std::string, FieldStats> fields;
  std::map<std::string, DescriptorFieldStats> descriptorFields;
  std::set<std::string> missingPlugins;
  std::set<std::string> descriptorMissingPlugins;
  std::set<std::string> missingPluginChangeFormPlugins;
  std::vector<nlohmann::json> examples;
  std::vector<nlohmann::json> descriptorExamples;
};

struct MigrationOptions
{
  bool deleteMissingPluginChangeForms = false;
  bool pruneMissingPluginReferences = false;
  bool repairActorWorldOrCellFallback = false;
};

struct RemediationStats
{
  size_t deletedMissingPluginChangeForms = 0;
  size_t prunedMissingPluginReferences = 0;
  size_t prunedInvalidSlotReferences = 0;
  size_t prunedMissingPluginDescriptors = 0;
  size_t repairedActorWorldOrCellFallbacks = 0;

  [[nodiscard]] bool HasWork() const noexcept
  {
    return deletedMissingPluginChangeForms > 0 ||
      prunedMissingPluginReferences > 0 ||
      prunedInvalidSlotReferences > 0 ||
      prunedMissingPluginDescriptors > 0 ||
      repairedActorWorldOrCellFallbacks > 0;
  }
};

struct RecordTypeExpectation
{
  enum class Kind
  {
    None,
    Exact,
    InventoryItem,
  };

  Kind kind = Kind::None;
  std::vector<std::string> exactTypes;
};

struct RecordTypeValidationContext
{
  const espm::CombineBrowser* browser = nullptr;
};

class ScopedSpdlogLevel
{
public:
  explicit ScopedSpdlogLevel(spdlog::level::level_enum level)
    : previousLevel(spdlog::get_level())
  {
    spdlog::set_level(level);
  }

  ~ScopedSpdlogLevel()
  {
    spdlog::set_level(previousLevel);
  }

  ScopedSpdlogLevel(const ScopedSpdlogLevel&) = delete;
  ScopedSpdlogLevel& operator=(const ScopedSpdlogLevel&) = delete;

private:
  spdlog::level::level_enum previousLevel;
};

const RecordTypeExpectation kInventoryItemExpectation{
  RecordTypeExpectation::Kind::InventoryItem, {}
};
const RecordTypeExpectation kEnchantmentExpectation{
  RecordTypeExpectation::Kind::Exact, { "ENCH" }
};
const RecordTypeExpectation kPoisonExpectation{
  RecordTypeExpectation::Kind::Exact, { "ALCH" }
};
const RecordTypeExpectation kRaceExpectation{
  RecordTypeExpectation::Kind::Exact, { "RACE" }
};
const RecordTypeExpectation kHeadpartExpectation{
  RecordTypeExpectation::Kind::Exact, { "HDPT" }
};
const RecordTypeExpectation kTextureSetExpectation{
  RecordTypeExpectation::Kind::Exact, { "TXST" }
};
const RecordTypeExpectation kSpellExpectation{
  RecordTypeExpectation::Kind::Exact, { "SPEL" }
};
const RecordTypeExpectation kShoutExpectation{
  RecordTypeExpectation::Kind::Exact, { "SHOU" }
};
const RecordTypeExpectation kWordExpectation{
  RecordTypeExpectation::Kind::Exact, { "WOOP" }
};
const RecordTypeExpectation kMagicEffectExpectation{
  RecordTypeExpectation::Kind::Exact, { "MGEF" }
};

std::shared_ptr<spdlog::logger> GetPreflightLogger()
{
  auto logger = spdlog::get("console");
  if (logger) {
    return logger;
  }
  return spdlog::stdout_color_mt("console");
}

std::string ToLower(std::string value)
{
  std::transform(value.begin(), value.end(), value.begin(), [](char ch) {
    return static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  });
  return value;
}

std::string HexFormId(uint32_t formId)
{
  std::ostringstream ss;
  ss << "0x" << std::hex << std::nouppercase << std::setfill('0')
     << std::setw(8) << formId;
  return ss.str();
}

std::string JoinStrings(const std::vector<std::string>& values,
                        const char* separator)
{
  std::ostringstream ss;
  for (size_t i = 0; i < values.size(); ++i) {
    if (i != 0) {
      ss << separator;
    }
    ss << values[i];
  }
  return ss.str();
}

std::string FormatFullSlot(uint16_t fullIndex)
{
  std::ostringstream ss;
  ss << std::hex << std::nouppercase << std::setfill('0') << std::setw(2)
     << fullIndex;
  return ss.str();
}

std::string FormatLightSlot(uint16_t lightIndex)
{
  std::ostringstream ss;
  ss << "FE" << std::hex << std::nouppercase << std::setfill('0')
     << std::setw(3) << lightIndex;
  return ss.str();
}

std::string FormatSlot(const PluginSnapshot& plugin)
{
  if (plugin.isLight) {
    return plugin.lightIndex ? FormatLightSlot(*plugin.lightIndex) : "FE???";
  }
  return plugin.fullIndex ? FormatFullSlot(*plugin.fullIndex) : "??";
}

SnapshotIndex BuildSnapshotIndex(const nlohmann::json& snapshot)
{
  if (!snapshot.contains("plugins") || !snapshot["plugins"].is_array()) {
    throw std::runtime_error("load-order snapshot doesn't contain plugins[]");
  }

  SnapshotIndex index;
  const auto pluginCount = snapshot["plugins"].size();
  index.plugins.reserve(pluginCount);
  index.byName.reserve(pluginCount);
  index.fullByIndex.assign(0xfe, kNoPlugin);
  index.lightByIndex.assign(0x1000, kNoPlugin);
  index.stableFullByIndex.assign(0xfe, 0);
  index.stableLightByIndex.assign(0x1000, 0);

  for (const auto& pluginJson : snapshot["plugins"]) {
    PluginSnapshot plugin;
    plugin.filename = pluginJson.at("filename").get<std::string>();
    plugin.key = ToLower(plugin.filename);
    plugin.crc32 = pluginJson.at("crc32").get<int64_t>();
    plugin.size = pluginJson.at("size").get<uint64_t>();
    plugin.isLight = pluginJson.value("isLight", false);

    if (pluginJson.contains("fullIndex") &&
        !pluginJson["fullIndex"].is_null()) {
      plugin.fullIndex = pluginJson["fullIndex"].get<uint16_t>();
    }

    if (pluginJson.contains("lightIndex") &&
        !pluginJson["lightIndex"].is_null()) {
      plugin.lightIndex = pluginJson["lightIndex"].get<uint16_t>();
    }

    const size_t pluginIdx = index.plugins.size();
    index.plugins.push_back(std::move(plugin));
    const auto& stored = index.plugins.back();
    index.byName[stored.key] = pluginIdx;

    if (stored.fullIndex && *stored.fullIndex < index.fullByIndex.size()) {
      index.fullByIndex[*stored.fullIndex] = pluginIdx;
    }

    if (stored.lightIndex && *stored.lightIndex < index.lightByIndex.size()) {
      index.lightByIndex[*stored.lightIndex] = pluginIdx;
    }
  }

  return index;
}

void MarkStableMappingSlots(SnapshotIndex& previous,
                            const SnapshotIndex& current)
{
  for (size_t fullIndex = 0; fullIndex < previous.fullByIndex.size();
       ++fullIndex) {
    const auto pluginIdx = previous.fullByIndex[fullIndex];
    if (pluginIdx == kNoPlugin) {
      continue;
    }

    const auto& previousPlugin = previous.plugins[pluginIdx];
    const auto currentIt = current.byName.find(previousPlugin.key);
    if (currentIt == current.byName.end()) {
      continue;
    }

    const auto& currentPlugin = current.plugins[currentIt->second];
    if (!currentPlugin.isLight && currentPlugin.fullIndex &&
        *currentPlugin.fullIndex == static_cast<uint16_t>(fullIndex)) {
      previous.stableFullByIndex[fullIndex] = 1;
    }
  }

  for (size_t lightIndex = 0; lightIndex < previous.lightByIndex.size();
       ++lightIndex) {
    const auto pluginIdx = previous.lightByIndex[lightIndex];
    if (pluginIdx == kNoPlugin) {
      continue;
    }

    const auto& previousPlugin = previous.plugins[pluginIdx];
    const auto currentIt = current.byName.find(previousPlugin.key);
    if (currentIt == current.byName.end()) {
      continue;
    }

    const auto& currentPlugin = current.plugins[currentIt->second];
    if (currentPlugin.isLight && currentPlugin.lightIndex &&
        *currentPlugin.lightIndex == static_cast<uint16_t>(lightIndex)) {
      previous.stableLightByIndex[lightIndex] = 1;
    }
  }
}

std::string GetFingerprint(const PluginSnapshot& plugin)
{
  return std::to_string(plugin.crc32) + ":" + std::to_string(plugin.size);
}

DescriptorRenamePlan BuildDescriptorRenamePlan(
  const SnapshotIndex& previous, const SnapshotIndex& current)
{
  DescriptorRenamePlan plan;
  std::unordered_map<std::string, std::vector<const PluginSnapshot*>>
    addedByFingerprint;
  plan.byOldKey.reserve(previous.plugins.size());
  addedByFingerprint.reserve(current.plugins.size());

  for (const auto& currentPlugin : current.plugins) {
    if (previous.byName.find(currentPlugin.key) != previous.byName.end()) {
      continue;
    }
    addedByFingerprint[GetFingerprint(currentPlugin)].push_back(
      &currentPlugin);
  }

  for (const auto& previousPlugin : previous.plugins) {
    const auto currentIt = current.byName.find(previousPlugin.key);
    if (currentIt != current.byName.end()) {
      const auto& currentPlugin = current.plugins[currentIt->second];
      if (currentPlugin.filename != previousPlugin.filename) {
        plan.byOldKey.emplace(
          previousPlugin.key,
          DescriptorRename{ previousPlugin.filename, previousPlugin.key,
                            currentPlugin.filename, "filename casing" });
      }
      continue;
    }

    const auto addedIt = addedByFingerprint.find(GetFingerprint(previousPlugin));
    if (addedIt == addedByFingerprint.end()) {
      continue;
    }

    const auto& candidates = addedIt->second;
    if (candidates.size() == 1) {
      plan.byOldKey.emplace(
        previousPlugin.key,
        DescriptorRename{ previousPlugin.filename, previousPlugin.key,
                          candidates.front()->filename, "crc32+size" });
    } else {
      auto& ambiguous = plan.ambiguousByOldKey[previousPlugin.key];
      for (const auto* candidate : candidates) {
        ambiguous.push_back(candidate->filename);
      }
    }
  }

  return plan;
}

bool CanSkipStableMapping(uint32_t formId, const SnapshotIndex& previous)
{
  if (formId == 0) {
    return false;
  }

  const uint32_t topByte = formId >> 24;
  if (topByte == 0xff) {
    return false;
  }

  if ((formId & kFullIndexMask) == kLightPrefix) {
    const auto lightIndex =
      static_cast<uint16_t>((formId >> 12) & kLightIndexMask);
    return lightIndex < previous.stableLightByIndex.size() &&
      previous.stableLightByIndex[lightIndex] != 0;
  }

  const auto fullIndex = static_cast<uint16_t>(topByte);
  return fullIndex < previous.stableFullByIndex.size() &&
    previous.stableFullByIndex[fullIndex] != 0;
}

struct DecodeResult
{
  enum class Kind
  {
    Skipped,
    Resolved,
    InvalidSlot,
  };

  Kind kind = Kind::Skipped;
  const PluginSnapshot* plugin = nullptr;
  uint32_t shortFormId = 0;
  std::string reason;
};

DecodeResult DecodeOldFormId(uint32_t formId, const SnapshotIndex& previous)
{
  if (formId == 0) {
    return { DecodeResult::Kind::Skipped };
  }

  const uint32_t topByte = formId >> 24;
  if (topByte == 0xff) {
    return { DecodeResult::Kind::Skipped };
  }

  if ((formId & kFullIndexMask) == kLightPrefix) {
    const auto lightIndex =
      static_cast<uint16_t>((formId >> 12) & kLightIndexMask);
    if (lightIndex >= previous.lightByIndex.size() ||
        previous.lightByIndex[lightIndex] == kNoPlugin) {
      return { DecodeResult::Kind::InvalidSlot,
               nullptr,
               formId & kLightIndexMask,
               "previous light slot " + FormatLightSlot(lightIndex) +
                 " is not present in the previous baseline" };
    }

    return { DecodeResult::Kind::Resolved,
             &previous.plugins[previous.lightByIndex[lightIndex]],
             formId & kLightIndexMask };
  }

  const auto fullIndex = static_cast<uint16_t>(topByte);
  if (fullIndex >= previous.fullByIndex.size() ||
      previous.fullByIndex[fullIndex] == kNoPlugin) {
    return { DecodeResult::Kind::InvalidSlot,
             nullptr,
             formId & kFullShortFormIdMask,
             "previous full slot " + FormatFullSlot(fullIndex) +
               " is not present in the previous baseline" };
  }

  return { DecodeResult::Kind::Resolved,
           &previous.plugins[previous.fullByIndex[fullIndex]],
           formId & kFullShortFormIdMask };
}

struct EncodeResult
{
  bool ok = false;
  uint32_t formId = 0;
  const PluginSnapshot* plugin = nullptr;
  std::string reason;
};

EncodeResult EncodeCurrentFormId(const PluginSnapshot& previousPlugin,
                                 uint32_t shortFormId,
                                 const SnapshotIndex& current)
{
  const auto currentIt = current.byName.find(previousPlugin.key);
  if (currentIt == current.byName.end()) {
    return { false,
             0,
             nullptr,
             "plugin '" + previousPlugin.filename +
               "' is missing from the current baseline" };
  }

  const auto& currentPlugin = current.plugins[currentIt->second];
  if (currentPlugin.isLight) {
    if (!currentPlugin.lightIndex) {
      return { false,
               0,
               &currentPlugin,
               "current light plugin '" + currentPlugin.filename +
                 "' has no light index" };
    }

    if (shortFormId > kLightIndexMask) {
      return { false,
               0,
               &currentPlugin,
               "short form-id " + HexFormId(shortFormId) +
                 " cannot fit in light-plugin address space" };
    }

    return { true,
             kLightPrefix |
               (static_cast<uint32_t>(*currentPlugin.lightIndex) << 12) |
               shortFormId,
             &currentPlugin };
  }

  if (!currentPlugin.fullIndex) {
    return { false,
             0,
             &currentPlugin,
             "current full plugin '" + currentPlugin.filename +
               "' has no full index" };
  }

  return { true,
           (static_cast<uint32_t>(*currentPlugin.fullIndex) << 24) |
             shortFormId,
           &currentPlugin };
}

void AddExample(PreflightStats& stats, const std::string& changeForm,
                const std::string& field, uint32_t oldFormId,
                const PluginSnapshot* oldPlugin,
                const PluginSnapshot* newPlugin,
                std::optional<uint32_t> newFormId,
                const std::string& status, const std::string& reason)
{
  if (stats.examples.size() >= kExampleLimit) {
    return;
  }

  auto example = nlohmann::json::object();
  example["changeForm"] = changeForm;
  example["field"] = field;
  example["oldFormId"] = HexFormId(oldFormId);
  example["status"] = status;
  example["reason"] = reason;

  if (oldPlugin) {
    example["oldPlugin"] = oldPlugin->filename;
    example["oldSlot"] = FormatSlot(*oldPlugin);
  }

  if (newPlugin) {
    example["newPlugin"] = newPlugin->filename;
    example["newSlot"] = FormatSlot(*newPlugin);
  }

  if (newFormId) {
    example["newFormId"] = HexFormId(*newFormId);
  }

  stats.examples.push_back(std::move(example));
}

bool HasRecordTypeExpectation(const RecordTypeExpectation& expectation)
{
  return expectation.kind != RecordTypeExpectation::Kind::None;
}

std::string FormatRecordTypeExpectation(
  const RecordTypeExpectation& expectation)
{
  switch (expectation.kind) {
    case RecordTypeExpectation::Kind::InventoryItem:
      return "inventory item";
    case RecordTypeExpectation::Kind::Exact:
      return JoinStrings(expectation.exactTypes, "|");
    case RecordTypeExpectation::Kind::None:
      break;
  }
  return "any record";
}

bool ShouldValidateRecordType(uint32_t formId,
                              const RecordTypeExpectation& expectation)
{
  if (!HasRecordTypeExpectation(expectation)) {
    return false;
  }

  if (formId == 0) {
    return false;
  }

  const uint32_t topByte = formId >> 24;
  return topByte != 0xff;
}

bool IsValidInventoryRecord(const espm::RecordHeader* record,
                            espm::CompressedFieldsCache& cache)
{
  if (!record) {
    return false;
  }

  if (espm::utils::IsPickupableItem(record, cache)) {
    return true;
  }

  return record->GetType() == "KEYM";
}

bool RecordMatchesExpectation(const espm::RecordHeader* record,
                              const RecordTypeExpectation& expectation,
                              espm::CompressedFieldsCache& cache)
{
  if (!record) {
    return false;
  }

  switch (expectation.kind) {
    case RecordTypeExpectation::Kind::InventoryItem:
      return IsValidInventoryRecord(record, cache);
    case RecordTypeExpectation::Kind::Exact:
      for (const auto& expectedType : expectation.exactTypes) {
        if (record->GetType() == expectedType.c_str()) {
          return true;
        }
      }
      return false;
    case RecordTypeExpectation::Kind::None:
      break;
  }

  return true;
}

const PluginSnapshot* ResolveCurrentPluginForFormId(
  uint32_t formId, const SnapshotIndex& current)
{
  const auto decoded = DecodeOldFormId(formId, current);
  if (decoded.kind == DecodeResult::Kind::Resolved) {
    return decoded.plugin;
  }
  return nullptr;
}

bool ValidateCurrentRecordType(uint32_t oldFormId, uint32_t currentFormId,
                               const std::string& field,
                               const std::string& changeForm,
                               const PluginSnapshot* oldPlugin,
                               const PluginSnapshot* currentPlugin,
                               const SnapshotIndex& current,
                               PreflightStats& stats,
                               const RecordTypeValidationContext& validation,
                               const RecordTypeExpectation& expectation)
{
  if (!ShouldValidateRecordType(currentFormId, expectation)) {
    return false;
  }

  if (!validation.browser) {
    throw std::runtime_error(
      "database load-order migration record type validation has no ESPM "
      "browser");
  }

  auto& fieldStats = stats.fields[field];
  const auto lookup = validation.browser->LookupById(currentFormId);
  const auto* resolvedCurrentPlugin = currentPlugin
    ? currentPlugin
    : ResolveCurrentPluginForFormId(currentFormId, current);
  const auto expected = FormatRecordTypeExpectation(expectation);

  if (!lookup.rec) {
    ++fieldStats.recordMissing;
    ++stats.recordMissingReferences;
    AddExample(stats, changeForm, field, oldFormId, oldPlugin,
               resolvedCurrentPlugin, currentFormId, "record-missing",
               "current record " + HexFormId(currentFormId) +
                 " was not found for expected " + expected);
    return true;
  }

  auto& cache = validation.browser->GetCache();
  if (RecordMatchesExpectation(lookup.rec, expectation, cache)) {
    return false;
  }

  ++fieldStats.recordTypeMismatch;
  ++stats.recordTypeMismatchReferences;
  AddExample(stats, changeForm, field, oldFormId, oldPlugin,
             resolvedCurrentPlugin, currentFormId, "record-type-mismatch",
             "expected " + expected + ", found " +
               lookup.rec->GetType().ToString());
  return true;
}

void AddDescriptorExample(PreflightStats& stats,
                          const std::string& changeForm,
                          const std::string& field,
                          const FormDesc& oldDesc,
                          std::optional<FormDesc> newDesc,
                          const std::string& status,
                          const std::string& reason)
{
  if (stats.descriptorExamples.size() >= kExampleLimit) {
    return;
  }

  auto example = nlohmann::json::object();
  example["changeForm"] = changeForm;
  example["field"] = field;
  example["oldDesc"] = oldDesc.ToString();
  example["status"] = status;
  example["reason"] = reason;

  if (newDesc) {
    example["newDesc"] = newDesc->ToString();
  }

  stats.descriptorExamples.push_back(std::move(example));
}

enum class DescriptorResolution
{
  Skipped,
  Current,
  Alias,
  Ambiguous,
  Missing,
};

DescriptorResolution GetDescriptorResolution(
  const FormDesc& desc, const SnapshotIndex& current,
  const DescriptorRenamePlan& renamePlan)
{
  if (desc.file.empty()) {
    return DescriptorResolution::Skipped;
  }

  const auto oldKey = ToLower(desc.file);
  if (current.byName.find(oldKey) != current.byName.end()) {
    return DescriptorResolution::Current;
  }

  if (renamePlan.byOldKey.find(oldKey) != renamePlan.byOldKey.end()) {
    return DescriptorResolution::Alias;
  }

  if (renamePlan.ambiguousByOldKey.find(oldKey) !=
      renamePlan.ambiguousByOldKey.end()) {
    return DescriptorResolution::Ambiguous;
  }

  return DescriptorResolution::Missing;
}

bool IsMissingPluginDescriptor(const FormDesc& desc,
                               const SnapshotIndex& current,
                               const DescriptorRenamePlan& renamePlan)
{
  return GetDescriptorResolution(desc, current, renamePlan) ==
    DescriptorResolution::Missing;
}

enum class PrunableFormIdReason
{
  None,
  MissingPlugin,
  InvalidSlot,
};

PrunableFormIdReason GetPrunableFormIdReason(uint32_t formId,
                                             const SnapshotIndex& previous,
                                             const SnapshotIndex& current)
{
  if (CanSkipStableMapping(formId, previous)) {
    return PrunableFormIdReason::None;
  }

  const auto decoded = DecodeOldFormId(formId, previous);
  if (decoded.kind == DecodeResult::Kind::InvalidSlot) {
    return PrunableFormIdReason::InvalidSlot;
  }

  if (decoded.kind == DecodeResult::Kind::Resolved &&
      current.byName.find(decoded.plugin->key) == current.byName.end()) {
    return PrunableFormIdReason::MissingPlugin;
  }

  return PrunableFormIdReason::None;
}

void CountPrunedFormIdReference(PrunableFormIdReason reason,
                                RemediationStats& remediationStats)
{
  switch (reason) {
    case PrunableFormIdReason::MissingPlugin:
      ++remediationStats.prunedMissingPluginReferences;
      break;
    case PrunableFormIdReason::InvalidSlot:
      ++remediationStats.prunedInvalidSlotReferences;
      break;
    case PrunableFormIdReason::None:
      break;
  }
}

FormDesc ResolveCurrentDescriptor(FormDesc desc, const SnapshotIndex& current,
                                  const DescriptorRenamePlan& renamePlan,
                                  const std::string& field)
{
  if (desc.file.empty()) {
    throw std::runtime_error(field + " must resolve to a plugin descriptor");
  }

  const auto oldKey = ToLower(desc.file);
  const auto currentIt = current.byName.find(oldKey);
  if (currentIt != current.byName.end()) {
    desc.file = current.plugins[currentIt->second].filename;
    return desc;
  }

  const auto aliasIt = renamePlan.byOldKey.find(oldKey);
  if (aliasIt != renamePlan.byOldKey.end()) {
    desc.file = aliasIt->second.newFilename;
    return desc;
  }

  throw std::runtime_error(field + " references plugin '" + desc.file +
                           "', which is not present in the current baseline");
}

uint32_t ParseFormIdValue(const nlohmann::json& value,
                          const std::string& field)
{
  auto validate = [&field](uint64_t parsed) -> uint32_t {
    if (parsed > std::numeric_limits<uint32_t>::max()) {
      throw std::runtime_error(field + " is outside uint32 range");
    }
    return static_cast<uint32_t>(parsed);
  };

  if (value.is_number_unsigned()) {
    return validate(value.get<uint64_t>());
  }

  if (value.is_number_integer()) {
    const auto parsed = value.get<int64_t>();
    if (parsed < 0) {
      throw std::runtime_error(field + " must not be negative");
    }
    return validate(static_cast<uint64_t>(parsed));
  }

  if (value.is_string()) {
    const auto str = value.get<std::string>();
    size_t parsedChars = 0;
    const auto parsed = std::stoull(str, &parsedChars, 0);
    if (parsedChars != str.size()) {
      throw std::runtime_error(field + " must be a form id or descriptor");
    }
    return validate(parsed);
  }

  throw std::runtime_error(field +
                           " must be a number, numeric string, or descriptor");
}

FormDesc FormDescFromCurrentFormId(uint32_t formId,
                                   const SnapshotIndex& current,
                                   const std::string& field)
{
  const auto decoded = DecodeOldFormId(formId, current);
  if (decoded.kind != DecodeResult::Kind::Resolved || !decoded.plugin) {
    throw std::runtime_error(field + " could not be resolved in current "
                             "load-order baseline");
  }

  return { decoded.shortFormId, decoded.plugin->filename };
}

NiPoint3 ParsePoint(const nlohmann::json& value, const std::string& field)
{
  if (!value.is_array() || value.size() != 3) {
    throw std::runtime_error(field + " must be an array of three numbers");
  }

  return { value.at(0).get<float>(), value.at(1).get<float>(),
           value.at(2).get<float>() };
}

std::optional<LocationalData> ParseTeleportPointFallback(
  const nlohmann::json& settings, const SnapshotIndex& current,
  const DescriptorRenamePlan& renamePlan)
{
  if (!settings.contains("teleportPointFallback") ||
      settings.at("teleportPointFallback").is_null()) {
    return std::nullopt;
  }

  const auto& fallback = settings.at("teleportPointFallback");
  if (!fallback.is_object()) {
    throw std::runtime_error("teleportPointFallback must be an object");
  }

  const std::string prefix = "teleportPointFallback.";
  LocationalData locationalData;
  locationalData.pos = ParsePoint(fallback.at("pos"), prefix + "pos");
  locationalData.rot = { 0.f, 0.f, fallback.at("angleZ").get<float>() };

  const auto& worldOrCell = fallback.at("worldOrCell");
  FormDesc worldOrCellDesc;
  if (worldOrCell.is_string() &&
      worldOrCell.get<std::string>().find(':') != std::string::npos) {
    worldOrCellDesc = FormDesc::FromString(worldOrCell.get<std::string>());
  } else {
    worldOrCellDesc = FormDescFromCurrentFormId(
      ParseFormIdValue(worldOrCell, prefix + "worldOrCell"), current,
      prefix + "worldOrCell");
  }

  locationalData.cellOrWorldDesc = ResolveCurrentDescriptor(
    worldOrCellDesc, current, renamePlan, prefix + "worldOrCell");
  return locationalData;
}

bool IsActorWorldOrCellFallbackCandidate(
  const MpChangeForm& changeForm, const SnapshotIndex& current,
  const DescriptorRenamePlan& renamePlan)
{
  if (changeForm.recType != MpChangeForm::RecType::ACHR) {
    return false;
  }

  const auto resolution =
    GetDescriptorResolution(changeForm.worldOrCellDesc, current, renamePlan);
  return resolution == DescriptorResolution::Skipped ||
    resolution == DescriptorResolution::Missing ||
    resolution == DescriptorResolution::Ambiguous;
}

bool ScanActorWorldOrCellFallbackCandidate(
  const MpChangeForm& changeForm, const std::string& changeFormDesc,
  const SnapshotIndex& current, const DescriptorRenamePlan& renamePlan,
  PreflightStats& stats)
{
  if (!IsActorWorldOrCellFallbackCandidate(changeForm, current, renamePlan)) {
    return false;
  }

  ++stats.actorWorldOrCellFallbackCandidates;
  AddDescriptorExample(
    stats, changeFormDesc, "worldOrCellDesc", changeForm.worldOrCellDesc,
    std::nullopt, "fallback-candidate",
    "actor world/cell descriptor cannot be resolved; teleportPointFallback "
    "repair is available");
  return true;
}

bool RepairActorWorldOrCellFallback(
  MpChangeForm& changeForm, const SnapshotIndex& current,
  const DescriptorRenamePlan& renamePlan, const MigrationOptions& options,
  const std::optional<LocationalData>& teleportPointFallback,
  RemediationStats& remediationStats)
{
  if (!options.repairActorWorldOrCellFallback ||
      !IsActorWorldOrCellFallbackCandidate(changeForm, current, renamePlan)) {
    return false;
  }

  if (!teleportPointFallback) {
    throw std::runtime_error(
      "cannot repair actor worldOrCellDesc because teleportPointFallback is "
      "not configured");
  }

  changeForm.position = teleportPointFallback->pos;
  changeForm.angle = teleportPointFallback->rot;
  changeForm.worldOrCellDesc = teleportPointFallback->cellOrWorldDesc;
  ++remediationStats.repairedActorWorldOrCellFallbacks;
  return true;
}

bool ProcessDescriptor(FormDesc& desc, const std::string& field,
                        const std::string& changeForm,
                        const SnapshotIndex& current,
                       const DescriptorRenamePlan& renamePlan,
                       PreflightStats& stats, bool apply)
{
  auto& fieldStats = stats.descriptorFields[field];

  if (desc.file.empty()) {
    ++fieldStats.skipped;
    ++stats.descriptorSkippedReferences;
    return false;
  }

  ++fieldStats.checked;
  ++stats.descriptorCheckedReferences;

  const auto oldKey = ToLower(desc.file);
  const auto currentIt = current.byName.find(oldKey);
  if (currentIt != current.byName.end()) {
    const auto& currentPlugin = current.plugins[currentIt->second];
    if (currentPlugin.filename == desc.file) {
      ++fieldStats.unchanged;
      ++stats.descriptorUnchangedReferences;
      return false;
    }

    FormDesc newDesc = desc;
    newDesc.file = currentPlugin.filename;
    ++fieldStats.renamed;
    ++stats.descriptorRenameReferences;
    AddDescriptorExample(stats, changeForm, field, desc, newDesc,
                         "renamed", "filename casing");
    if (apply) {
      desc = std::move(newDesc);
    }
    return true;
  }

  const auto aliasIt = renamePlan.byOldKey.find(oldKey);
  if (aliasIt != renamePlan.byOldKey.end()) {
    FormDesc newDesc = desc;
    newDesc.file = aliasIt->second.newFilename;
    ++fieldStats.renamed;
    ++stats.descriptorRenameReferences;
    AddDescriptorExample(stats, changeForm, field, desc, newDesc,
                         "renamed", aliasIt->second.reason);
    if (apply) {
      desc = std::move(newDesc);
    }
    return true;
  }

  const auto ambiguousIt = renamePlan.ambiguousByOldKey.find(oldKey);
  if (ambiguousIt != renamePlan.ambiguousByOldKey.end()) {
    ++fieldStats.ambiguousRename;
    ++stats.descriptorAmbiguousRenameReferences;
    AddDescriptorExample(stats, changeForm, field, desc, std::nullopt,
                         "ambiguous-rename",
                         "candidates: " +
                           JoinStrings(ambiguousIt->second, ", "));
    return true;
  }

  ++fieldStats.missingPlugin;
  ++stats.descriptorMissingPluginReferences;
  stats.descriptorMissingPlugins.insert(desc.file);
  AddDescriptorExample(stats, changeForm, field, desc, std::nullopt,
                       "missing-plugin",
                       "descriptor plugin is missing from current baseline");
  return true;
}

bool ScanDescriptor(FormDesc desc, const std::string& field,
                    const std::string& changeForm,
                    const SnapshotIndex& current,
                    const DescriptorRenamePlan& renamePlan,
                    PreflightStats& stats)
{
  return ProcessDescriptor(desc, field, changeForm, current, renamePlan,
                           stats, false);
}

bool ProcessFormId(uint32_t& formId, const std::string& field,
                   const std::string& changeForm,
                   const SnapshotIndex& previous,
                   const SnapshotIndex& current, PreflightStats& stats,
                   bool apply,
                   const RecordTypeValidationContext& validation,
                   const RecordTypeExpectation& expectation)
{
  auto& fieldStats = stats.fields[field];
  if (CanSkipStableMapping(formId, previous)) {
    ++fieldStats.skipped;
    ++fieldStats.stableMappingSkipped;
    ++stats.skippedReferences;
    ++stats.stableMappingSkippedReferences;
    const auto previousDecoded = DecodeOldFormId(formId, previous);
    const auto* oldPlugin =
      previousDecoded.kind == DecodeResult::Kind::Resolved
      ? previousDecoded.plugin
      : nullptr;
    return ValidateCurrentRecordType(
      formId, formId, field, changeForm, oldPlugin,
      ResolveCurrentPluginForFormId(formId, current), current, stats,
      validation, expectation);
  }

  const auto decoded = DecodeOldFormId(formId, previous);

  if (decoded.kind == DecodeResult::Kind::Skipped) {
    ++fieldStats.skipped;
    ++stats.skippedReferences;
    return false;
  }

  ++fieldStats.checked;
  ++stats.checkedReferences;

  if (decoded.kind == DecodeResult::Kind::InvalidSlot) {
    ++fieldStats.invalidSlot;
    ++stats.invalidSlotReferences;
    AddExample(stats, changeForm, field, formId, nullptr, nullptr,
               std::nullopt, "invalid-slot", decoded.reason);
    return true;
  }

  const auto encoded =
    EncodeCurrentFormId(*decoded.plugin, decoded.shortFormId, current);
  if (!encoded.ok) {
    if (encoded.reason.find("missing from the current baseline") !=
        std::string::npos) {
      ++fieldStats.missingPlugin;
      ++stats.missingPluginReferences;
      stats.missingPlugins.insert(decoded.plugin->filename);
      AddExample(stats, changeForm, field, formId, decoded.plugin, nullptr,
                 std::nullopt, "missing-plugin", encoded.reason);
      return true;
    }

    ++fieldStats.cannotEncode;
    ++stats.cannotEncodeReferences;
    AddExample(stats, changeForm, field, formId, decoded.plugin,
               encoded.plugin, std::nullopt, "cannot-encode",
               encoded.reason);
    return true;
  }

  if (ValidateCurrentRecordType(formId, encoded.formId, field, changeForm,
                                decoded.plugin, encoded.plugin, current,
                                stats, validation, expectation)) {
    return true;
  }

  if (encoded.formId == formId) {
    ++fieldStats.unchanged;
    ++stats.unchangedReferences;
    return false;
  }

  ++fieldStats.migratable;
  ++stats.migratableReferences;
  AddExample(stats, changeForm, field, formId, decoded.plugin, encoded.plugin,
             encoded.formId, "migratable",
             decoded.plugin->filename + ": " + FormatSlot(*decoded.plugin) +
               " -> " + FormatSlot(*encoded.plugin));
  if (apply) {
    formId = encoded.formId;
  }
  return true;
}

bool ScanFormId(uint32_t formId, const std::string& field,
                const std::string& changeForm, const SnapshotIndex& previous,
                const SnapshotIndex& current, PreflightStats& stats,
                const RecordTypeValidationContext& validation,
                const RecordTypeExpectation& expectation)
{
  return ProcessFormId(formId, field, changeForm, previous, current, stats,
                       false, validation, expectation);
}

bool ProcessInventory(Inventory& inventory, const std::string& prefix,
                      const std::string& changeForm,
                      const SnapshotIndex& previous,
                      const SnapshotIndex& current, PreflightStats& stats,
                      bool apply,
                      const RecordTypeValidationContext& validation)
{
  bool affected = false;
  const auto baseIdField = prefix + ".entries[].baseId";
  const auto enchantmentIdField = prefix + ".entries[].enchantmentId";
  const auto poisonIdField = prefix + ".entries[].poisonId";
  for (auto& entry : inventory.entries) {
    affected |= ProcessFormId(entry.baseId, baseIdField, changeForm, previous,
                              current, stats, apply, validation,
                              kInventoryItemExpectation);

    if (entry.enchantmentId) {
      affected |= ProcessFormId(*entry.enchantmentId, enchantmentIdField,
                                changeForm, previous, current, stats, apply,
                                validation, kEnchantmentExpectation);
    }

    if (entry.poisonId) {
      affected |= ProcessFormId(*entry.poisonId, poisonIdField, changeForm,
                                previous, current, stats, apply, validation,
                                kPoisonExpectation);
    }
  }
  return affected;
}

bool ScanInventory(const Inventory& inventory, const std::string& prefix,
                   const std::string& changeForm,
                   const SnapshotIndex& previous,
                   const SnapshotIndex& current, PreflightStats& stats,
                   const RecordTypeValidationContext& validation)
{
  bool affected = false;
  const auto baseIdField = prefix + ".entries[].baseId";
  const auto enchantmentIdField = prefix + ".entries[].enchantmentId";
  const auto poisonIdField = prefix + ".entries[].poisonId";
  for (const auto& entry : inventory.entries) {
    affected |= ScanFormId(entry.baseId, baseIdField, changeForm, previous,
                           current, stats, validation,
                           kInventoryItemExpectation);

    if (entry.enchantmentId) {
      affected |= ScanFormId(*entry.enchantmentId, enchantmentIdField,
                             changeForm, previous, current, stats, validation,
                             kEnchantmentExpectation);
    }

    if (entry.poisonId) {
      affected |= ScanFormId(*entry.poisonId, poisonIdField, changeForm,
                             previous, current, stats, validation,
                             kPoisonExpectation);
    }
  }
  return affected;
}

bool ProcessOptionalFormId(std::optional<uint32_t>& formId,
                           const std::string& field,
                           const std::string& changeForm,
                           const SnapshotIndex& previous,
                           const SnapshotIndex& current, PreflightStats& stats,
                           bool apply,
                           const RecordTypeValidationContext& validation,
                           const RecordTypeExpectation& expectation)
{
  if (!formId) {
    return false;
  }

  return ProcessFormId(*formId, field, changeForm, previous, current, stats,
                       apply, validation, expectation);
}

bool ScanOptionalFormId(const std::optional<uint32_t>& formId,
                        const std::string& field,
                        const std::string& changeForm,
                        const SnapshotIndex& previous,
                        const SnapshotIndex& current, PreflightStats& stats,
                        const RecordTypeValidationContext& validation,
                        const RecordTypeExpectation& expectation)
{
  if (!formId) {
    return false;
  }

  return ScanFormId(*formId, field, changeForm, previous, current, stats,
                    validation, expectation);
}

bool ProcessAppearanceDump(std::string& appearanceDump,
                           const std::string& changeForm,
                           const SnapshotIndex& previous,
                           const SnapshotIndex& current, PreflightStats& stats,
                           bool apply,
                           const RecordTypeValidationContext& validation)
{
  if (appearanceDump.empty()) {
    return false;
  }

  try {
    auto appearance = Appearance::FromJson(nlohmann::json::parse(
      appearanceDump));

    bool affected = false;
    affected |= ProcessFormId(appearance.raceId, "appearanceDump.raceId",
                              changeForm, previous, current, stats, apply,
                              validation, kRaceExpectation);
    for (auto& headpartId : appearance.headpartIds) {
      affected |= ProcessFormId(headpartId, "appearanceDump.headpartIds[]",
                                changeForm, previous, current, stats, apply,
                                validation, kHeadpartExpectation);
    }
    affected |= ProcessFormId(appearance.headTextureSetId,
                              "appearanceDump.headTextureSetId", changeForm,
                              previous, current, stats, apply, validation,
                              kTextureSetExpectation);
    if (affected && apply) {
      appearanceDump = appearance.ToJson();
    }
    return affected;
  } catch (const std::exception& e) {
    ++stats.appearanceParseErrors;
    AddExample(stats, changeForm, "appearanceDump", 0, nullptr, nullptr,
               std::nullopt, "parse-error", e.what());
    return true;
  }
}

bool ScanAppearanceDump(const std::string& appearanceDump,
                        const std::string& changeForm,
                        const SnapshotIndex& previous,
                        const SnapshotIndex& current, PreflightStats& stats,
                        const RecordTypeValidationContext& validation)
{
  if (appearanceDump.empty()) {
    return false;
  }

  try {
    const auto appearance =
      Appearance::FromJson(nlohmann::json::parse(appearanceDump));

    bool affected = false;
    auto raceId = appearance.raceId;
    affected |= ScanFormId(raceId, "appearanceDump.raceId", changeForm,
                           previous, current, stats, validation,
                           kRaceExpectation);
    for (auto headpartId : appearance.headpartIds) {
      affected |= ScanFormId(headpartId, "appearanceDump.headpartIds[]",
                             changeForm, previous, current, stats, validation,
                             kHeadpartExpectation);
    }
    auto headTextureSetId = appearance.headTextureSetId;
    affected |= ScanFormId(headTextureSetId,
                           "appearanceDump.headTextureSetId", changeForm,
                           previous, current, stats, validation,
                           kTextureSetExpectation);
    return affected;
  } catch (const std::exception& e) {
    ++stats.appearanceParseErrors;
    AddExample(stats, changeForm, "appearanceDump", 0, nullptr, nullptr,
               std::nullopt, "parse-error", e.what());
    return true;
  }
}

bool ProcessLearnedSpells(LearnedSpells& learnedSpells,
                          const std::string& changeForm,
                          const SnapshotIndex& previous,
                          const SnapshotIndex& current, PreflightStats& stats,
                          bool apply,
                          const RecordTypeValidationContext& validation)
{
  bool affected = false;

  if (!apply) {
    learnedSpells.ForEachSpell([&](uint32_t spellId) {
      affected |= ScanFormId(spellId, "learnedSpells[]", changeForm,
                             previous, current, stats, validation,
                             kSpellExpectation);
    });
    return affected;
  }

  LearnedSpells migrated;
  learnedSpells.ForEachSpell([&](uint32_t spellId) {
    auto migratedSpellId = spellId;
    const bool spellAffected =
      ProcessFormId(migratedSpellId, "learnedSpells[]", changeForm, previous,
                    current, stats, true, validation, kSpellExpectation);
    affected |= spellAffected;
    migrated.LearnSpell(migratedSpellId);
  });

  if (affected) {
    learnedSpells = std::move(migrated);
  }

  return affected;
}

bool ScanLearnedSpells(const LearnedSpells& learnedSpells,
                       const std::string& changeForm,
                       const SnapshotIndex& previous,
                       const SnapshotIndex& current, PreflightStats& stats,
                       const RecordTypeValidationContext& validation)
{
  bool affected = false;
  learnedSpells.ForEachSpell([&](uint32_t spellId) {
    affected |= ScanFormId(spellId, "learnedSpells[]", changeForm, previous,
                           current, stats, validation, kSpellExpectation);
  });
  return affected;
}

bool ProcessLearnedShouts(LearnedShouts& learnedShouts,
                          const std::string& changeForm,
                          const SnapshotIndex& previous,
                          const SnapshotIndex& current, PreflightStats& stats,
                          bool apply,
                          const RecordTypeValidationContext& validation)
{
  bool affected = false;

  if (!apply) {
    learnedShouts.ForEachShout([&](uint32_t shoutId) {
      affected |= ScanFormId(shoutId, "learnedShouts[]", changeForm,
                             previous, current, stats, validation,
                             kShoutExpectation);
    });
    return affected;
  }

  LearnedShouts migrated;
  learnedShouts.ForEachShout([&](uint32_t shoutId) {
    auto migratedShoutId = shoutId;
    const bool shoutAffected =
      ProcessFormId(migratedShoutId, "learnedShouts[]", changeForm, previous,
                    current, stats, true, validation, kShoutExpectation);
    affected |= shoutAffected;
    migrated.LearnShout(migratedShoutId);
  });

  if (affected) {
    learnedShouts = std::move(migrated);
  }

  return affected;
}

bool ScanLearnedShouts(const LearnedShouts& learnedShouts,
                       const std::string& changeForm,
                       const SnapshotIndex& previous,
                       const SnapshotIndex& current, PreflightStats& stats,
                       const RecordTypeValidationContext& validation)
{
  bool affected = false;
  learnedShouts.ForEachShout([&](uint32_t shoutId) {
    affected |= ScanFormId(shoutId, "learnedShouts[]", changeForm, previous,
                           current, stats, validation, kShoutExpectation);
  });
  return affected;
}

bool ProcessUnlockedWords(UnlockedWords& unlockedWords,
                          const std::string& changeForm,
                          const SnapshotIndex& previous,
                          const SnapshotIndex& current, PreflightStats& stats,
                          bool apply,
                          const RecordTypeValidationContext& validation)
{
  bool affected = false;

  if (!apply) {
    unlockedWords.ForEachWord([&](uint32_t wordId) {
      affected |= ScanFormId(wordId, "unlockedWords[]", changeForm, previous,
                             current, stats, validation, kWordExpectation);
    });
    return affected;
  }

  UnlockedWords migrated;
  unlockedWords.ForEachWord([&](uint32_t wordId) {
    auto migratedWordId = wordId;
    const bool wordAffected =
      ProcessFormId(migratedWordId, "unlockedWords[]", changeForm, previous,
                    current, stats, true, validation, kWordExpectation);
    affected |= wordAffected;
    migrated.UnlockWord(migratedWordId);
  });

  if (affected) {
    unlockedWords = std::move(migrated);
  }

  return affected;
}

bool ScanUnlockedWords(const UnlockedWords& unlockedWords,
                       const std::string& changeForm,
                       const SnapshotIndex& previous,
                       const SnapshotIndex& current, PreflightStats& stats,
                       const RecordTypeValidationContext& validation)
{
  bool affected = false;
  unlockedWords.ForEachWord([&](uint32_t wordId) {
    affected |= ScanFormId(wordId, "unlockedWords[]", changeForm, previous,
                           current, stats, validation, kWordExpectation);
  });
  return affected;
}

bool ProcessActiveMagicEffects(ActiveMagicEffectsMap& activeMagicEffects,
                               const std::string& changeForm,
                               const SnapshotIndex& previous,
                               const SnapshotIndex& current,
                               PreflightStats& stats, bool apply,
                               const RecordTypeValidationContext& validation)
{
  bool affected = false;

  if (apply) {
    activeMagicEffects.TransformEffectIds([&](uint32_t effectId) {
      uint32_t migratedEffectId = effectId;
      const bool effectAffected =
        ProcessFormId(migratedEffectId, "effects[].effectId", changeForm,
                      previous, current, stats, true, validation,
                      kMagicEffectExpectation);
      affected |= effectAffected;
      return migratedEffectId;
    });
    return affected;
  }

  activeMagicEffects.ForEachEffect([&](const auto& effect) {
    auto effectId = effect.effectId;
    affected |= ProcessFormId(effectId, "effects[].effectId", changeForm,
                              previous, current, stats, false, validation,
                              kMagicEffectExpectation);
  });

  return affected;
}

bool ScanActiveMagicEffects(const ActiveMagicEffectsMap& activeMagicEffects,
                            const std::string& changeForm,
                            const SnapshotIndex& previous,
                            const SnapshotIndex& current,
                            PreflightStats& stats,
                            const RecordTypeValidationContext& validation)
{
  bool affected = false;
  activeMagicEffects.ForEachEffect([&](const auto& effect) {
    affected |= ScanFormId(effect.effectId, "effects[].effectId", changeForm,
                           previous, current, stats, validation,
                           kMagicEffectExpectation);
  });
  return affected;
}

bool PruneInventoryUnresolvableReferences(
  Inventory& inventory, const SnapshotIndex& previous,
  const SnapshotIndex& current, RemediationStats& remediationStats)
{
  bool affected = false;
  inventory.entries.erase(
    std::remove_if(inventory.entries.begin(), inventory.entries.end(),
                   [&](const Inventory::Entry& entry) {
                     const auto reason = GetPrunableFormIdReason(
                       entry.baseId, previous, current);
                     if (reason == PrunableFormIdReason::None) {
                       return false;
                     }
                     CountPrunedFormIdReference(reason, remediationStats);
                     affected = true;
                     return true;
                   }),
    inventory.entries.end());

  for (auto& entry : inventory.entries) {
    const auto enchantmentReason = entry.enchantmentId
      ? GetPrunableFormIdReason(*entry.enchantmentId, previous, current)
      : PrunableFormIdReason::None;
    if (enchantmentReason != PrunableFormIdReason::None) {
      entry.enchantmentId.reset();
      CountPrunedFormIdReference(enchantmentReason, remediationStats);
      affected = true;
    }

    const auto poisonReason = entry.poisonId
      ? GetPrunableFormIdReason(*entry.poisonId, previous, current)
      : PrunableFormIdReason::None;
    if (poisonReason != PrunableFormIdReason::None) {
      entry.poisonId.reset();
      CountPrunedFormIdReference(poisonReason, remediationStats);
      affected = true;
    }
  }

  return affected;
}

bool PruneOptionalUnresolvableFormId(
  std::optional<uint32_t>& formId, const SnapshotIndex& previous,
  const SnapshotIndex& current, RemediationStats& remediationStats)
{
  if (!formId) {
    return false;
  }

  const auto reason = GetPrunableFormIdReason(*formId, previous, current);
  if (reason == PrunableFormIdReason::None) {
    return false;
  }

  formId.reset();
  CountPrunedFormIdReference(reason, remediationStats);
  return true;
}

bool PruneLearnedSpellsUnresolvableReferences(
  LearnedSpells& learnedSpells, const SnapshotIndex& previous,
  const SnapshotIndex& current, RemediationStats& remediationStats)
{
  bool affected = false;
  LearnedSpells pruned;
  learnedSpells.ForEachSpell([&](uint32_t spellId) {
    const auto reason = GetPrunableFormIdReason(spellId, previous, current);
    if (reason != PrunableFormIdReason::None) {
      CountPrunedFormIdReference(reason, remediationStats);
      affected = true;
      return;
    }
    pruned.LearnSpell(spellId);
  });

  if (affected) {
    learnedSpells = std::move(pruned);
  }
  return affected;
}

bool PruneLearnedShoutsUnresolvableReferences(
  LearnedShouts& learnedShouts, const SnapshotIndex& previous,
  const SnapshotIndex& current, RemediationStats& remediationStats)
{
  bool affected = false;
  LearnedShouts pruned;
  learnedShouts.ForEachShout([&](uint32_t shoutId) {
    const auto reason = GetPrunableFormIdReason(shoutId, previous, current);
    if (reason != PrunableFormIdReason::None) {
      CountPrunedFormIdReference(reason, remediationStats);
      affected = true;
      return;
    }
    pruned.LearnShout(shoutId);
  });

  if (affected) {
    learnedShouts = std::move(pruned);
  }
  return affected;
}

bool PruneUnlockedWordsUnresolvableReferences(
  UnlockedWords& unlockedWords, const SnapshotIndex& previous,
  const SnapshotIndex& current, RemediationStats& remediationStats)
{
  bool affected = false;
  UnlockedWords pruned;
  unlockedWords.ForEachWord([&](uint32_t wordId) {
    const auto reason = GetPrunableFormIdReason(wordId, previous, current);
    if (reason != PrunableFormIdReason::None) {
      CountPrunedFormIdReference(reason, remediationStats);
      affected = true;
      return;
    }
    pruned.UnlockWord(wordId);
  });

  if (affected) {
    unlockedWords = std::move(pruned);
  }
  return affected;
}

bool PruneActiveEffectsUnresolvableReferences(
  ActiveMagicEffectsMap& activeMagicEffects, const SnapshotIndex& previous,
  const SnapshotIndex& current, RemediationStats& remediationStats)
{
  const auto removed = activeMagicEffects.RemoveEffectsIf(
    [&](const auto& effect) {
      const auto reason =
        GetPrunableFormIdReason(effect.effectId, previous, current);
      if (reason == PrunableFormIdReason::None) {
        return false;
      }
      CountPrunedFormIdReference(reason, remediationStats);
      return true;
    });
  return removed != 0;
}

bool PruneAppearanceUnresolvableReferences(
  std::string& appearanceDump, const SnapshotIndex& previous,
  const SnapshotIndex& current, RemediationStats& remediationStats)
{
  if (appearanceDump.empty()) {
    return false;
  }

  try {
    auto appearance = Appearance::FromJson(nlohmann::json::parse(
      appearanceDump));

    bool affected = false;
    appearance.headpartIds.erase(
      std::remove_if(appearance.headpartIds.begin(),
                     appearance.headpartIds.end(),
                     [&](uint32_t headpartId) {
                       const auto reason = GetPrunableFormIdReason(
                         headpartId, previous, current);
                       if (reason == PrunableFormIdReason::None) {
                         return false;
                       }
                       CountPrunedFormIdReference(reason, remediationStats);
                       affected = true;
                       return true;
                     }),
      appearance.headpartIds.end());

    if (affected) {
      appearanceDump = appearance.ToJson();
    }
    return affected;
  } catch (const std::exception&) {
    return false;
  }
}

bool PruneMissingPluginDescriptors(
  std::vector<FormDesc>& descriptors, const SnapshotIndex& current,
  const DescriptorRenamePlan& renamePlan, RemediationStats& remediationStats)
{
  bool affected = false;
  descriptors.erase(
    std::remove_if(descriptors.begin(), descriptors.end(),
                   [&](const FormDesc& desc) {
                     if (!IsMissingPluginDescriptor(desc, current,
                                                    renamePlan)) {
                       return false;
                     }
                     ++remediationStats.prunedMissingPluginDescriptors;
                     affected = true;
                     return true;
                   }),
    descriptors.end());
  return affected;
}

bool PruneMissingPluginTextureSetDescriptors(
  std::optional<std::map<std::string, std::string>>& setNodeTextureSet,
  const SnapshotIndex& current, const DescriptorRenamePlan& renamePlan,
  RemediationStats& remediationStats)
{
  if (!setNodeTextureSet) {
    return false;
  }

  bool affected = false;
  for (auto it = setNodeTextureSet->begin(); it != setNodeTextureSet->end();) {
    const auto textureSetDesc = FormDesc::FromString(it->second);
    if (IsMissingPluginDescriptor(textureSetDesc, current, renamePlan)) {
      it = setNodeTextureSet->erase(it);
      ++remediationStats.prunedMissingPluginDescriptors;
      affected = true;
    } else {
      ++it;
    }
  }

  if (setNodeTextureSet->empty()) {
    setNodeTextureSet.reset();
  }
  return affected;
}

bool PruneMissingPluginFactions(
  std::optional<std::vector<Faction>>& factions, const SnapshotIndex& current,
  const DescriptorRenamePlan& renamePlan, RemediationStats& remediationStats)
{
  if (!factions) {
    return false;
  }

  bool affected = false;
  factions->erase(
    std::remove_if(factions->begin(), factions->end(),
                   [&](const Faction& faction) {
                     if (!IsMissingPluginDescriptor(faction.formDesc, current,
                                                    renamePlan)) {
                       return false;
                     }
                     ++remediationStats.prunedMissingPluginDescriptors;
                     affected = true;
                     return true;
                   }),
    factions->end());

  if (factions->empty()) {
    factions.reset();
  }
  return affected;
}

bool PruneUnresolvableReferences(
  MpChangeForm& changeForm, const SnapshotIndex& previous,
  const SnapshotIndex& current, const DescriptorRenamePlan& renamePlan,
  const MigrationOptions& options, RemediationStats& remediationStats)
{
  if (!options.pruneMissingPluginReferences) {
    return false;
  }

  bool affected = false;
  affected |= PruneInventoryUnresolvableReferences(
    changeForm.inv, previous, current, remediationStats);
  affected |= PruneInventoryUnresolvableReferences(
    changeForm.equipment.inv, previous, current, remediationStats);
  affected |= PruneOptionalUnresolvableFormId(
    changeForm.equipment.leftSpell, previous, current, remediationStats);
  affected |= PruneOptionalUnresolvableFormId(
    changeForm.equipment.rightSpell, previous, current, remediationStats);
  affected |= PruneOptionalUnresolvableFormId(
    changeForm.equipment.voiceSpell, previous, current, remediationStats);
  affected |= PruneOptionalUnresolvableFormId(
    changeForm.equipment.equippedShout, previous, current, remediationStats);
  affected |= PruneOptionalUnresolvableFormId(
    changeForm.equipment.instantSpell, previous, current, remediationStats);
  affected |= PruneLearnedSpellsUnresolvableReferences(
    changeForm.learnedSpells, previous, current, remediationStats);
  affected |= PruneLearnedShoutsUnresolvableReferences(
    changeForm.learnedShouts, previous, current, remediationStats);
  affected |= PruneUnlockedWordsUnresolvableReferences(
    changeForm.unlockedWords, previous, current, remediationStats);
  affected |= PruneActiveEffectsUnresolvableReferences(
    changeForm.activeMagicEffects, previous, current, remediationStats);
  affected |= PruneAppearanceUnresolvableReferences(
    changeForm.appearanceDump, previous, current, remediationStats);
  affected |= PruneMissingPluginDescriptors(changeForm.templateChain, current,
                                            renamePlan, remediationStats);
  affected |= PruneMissingPluginTextureSetDescriptors(
    changeForm.setNodeTextureSet, current, renamePlan, remediationStats);
  affected |= PruneMissingPluginFactions(changeForm.factions, current,
                                         renamePlan, remediationStats);
  return affected;
}

bool ShouldDeleteMissingPluginChangeForm(
  const MpChangeForm& changeForm, const SnapshotIndex& current,
  const DescriptorRenamePlan& renamePlan, const MigrationOptions& options)
{
  return options.deleteMissingPluginChangeForms &&
    (IsMissingPluginDescriptor(changeForm.formDesc, current, renamePlan) ||
     IsMissingPluginDescriptor(changeForm.baseDesc, current, renamePlan));
}

bool ProcessChangeForm(MpChangeForm& changeForm,
                       const SnapshotIndex& previous,
                       const SnapshotIndex& current,
                       const DescriptorRenamePlan& renamePlan,
                       PreflightStats& stats, bool apply,
                       const RecordTypeValidationContext& validation)
{
  const auto changeFormDesc = changeForm.formDesc.ToString();
  bool affected = false;

  affected |= ProcessDescriptor(changeForm.formDesc, "formDesc",
                                changeFormDesc, current, renamePlan, stats,
                                apply);
  affected |= ProcessDescriptor(changeForm.baseDesc, "baseDesc",
                                changeFormDesc, current, renamePlan, stats,
                                apply);
  affected |= ProcessDescriptor(changeForm.worldOrCellDesc,
                                "worldOrCellDesc", changeFormDesc, current,
                                renamePlan, stats, apply);
  affected |= ProcessDescriptor(changeForm.spawnPoint.cellOrWorldDesc,
                                "spawnPoint_cellOrWorldDesc", changeFormDesc,
                                current, renamePlan, stats, apply);

  for (auto& templateDesc : changeForm.templateChain) {
    affected |= ProcessDescriptor(templateDesc, "templateChain[]",
                                  changeFormDesc, current, renamePlan, stats,
                                  apply);
  }

  if (changeForm.setNodeTextureSet) {
    for (auto& [nodeName, textureSetDesc] : *changeForm.setNodeTextureSet) {
      (void)nodeName;
      auto textureSetFormDesc = FormDesc::FromString(textureSetDesc);
      const bool textureSetAffected =
        ProcessDescriptor(textureSetFormDesc, "setNodeTextureSet.*",
                          changeFormDesc, current, renamePlan, stats, apply);
      affected |= textureSetAffected;
      if (textureSetAffected && apply) {
        textureSetDesc = textureSetFormDesc.ToString();
      }
    }
  }

  if (changeForm.factions) {
    for (auto& faction : *changeForm.factions) {
      affected |= ProcessDescriptor(faction.formDesc,
                                    "factions.entries[].formDesc",
                                    changeFormDesc, current, renamePlan,
                                    stats, apply);
    }
  }

  affected |= ProcessInventory(changeForm.inv, "inv", changeFormDesc,
                               previous, current, stats, apply, validation);
  affected |= ProcessInventory(changeForm.equipment.inv, "equipmentDump.inv",
                               changeFormDesc, previous, current, stats,
                               apply, validation);

  affected |= ProcessOptionalFormId(changeForm.equipment.leftSpell,
                                    "equipmentDump.leftSpell", changeFormDesc,
                                    previous, current, stats, apply,
                                    validation, kSpellExpectation);
  affected |= ProcessOptionalFormId(changeForm.equipment.rightSpell,
                                    "equipmentDump.rightSpell", changeFormDesc,
                                    previous, current, stats, apply,
                                    validation, kSpellExpectation);
  affected |= ProcessOptionalFormId(changeForm.equipment.voiceSpell,
                                    "equipmentDump.voiceSpell", changeFormDesc,
                                    previous, current, stats, apply,
                                    validation, kSpellExpectation);
  affected |= ProcessOptionalFormId(changeForm.equipment.equippedShout,
                                    "equipmentDump.equippedShout",
                                    changeFormDesc, previous, current, stats,
                                    apply, validation, kShoutExpectation);
  affected |= ProcessOptionalFormId(changeForm.equipment.instantSpell,
                                    "equipmentDump.instantSpell",
                                    changeFormDesc, previous, current, stats,
                                    apply, validation, kSpellExpectation);

  affected |= ProcessLearnedSpells(changeForm.learnedSpells, changeFormDesc,
                                   previous, current, stats, apply,
                                   validation);
  affected |= ProcessLearnedShouts(changeForm.learnedShouts, changeFormDesc,
                                   previous, current, stats, apply,
                                   validation);
  affected |= ProcessUnlockedWords(changeForm.unlockedWords, changeFormDesc,
                                   previous, current, stats, apply,
                                   validation);

  affected |= ProcessActiveMagicEffects(changeForm.activeMagicEffects,
                                        changeFormDesc, previous, current,
                                        stats, apply, validation);

  affected |= ProcessAppearanceDump(changeForm.appearanceDump, changeFormDesc,
                                    previous, current, stats, apply,
                                    validation);

  return affected;
}

bool ScanChangeForm(const MpChangeForm& changeForm,
                    const SnapshotIndex& previous,
                    const SnapshotIndex& current,
                    const DescriptorRenamePlan& renamePlan,
                    PreflightStats& stats,
                    const RecordTypeValidationContext& validation)
{
  const auto changeFormDesc = changeForm.formDesc.ToString();
  bool affected = false;

  if (IsMissingPluginDescriptor(changeForm.formDesc, current, renamePlan)) {
    ++stats.missingPluginChangeForms;
    stats.missingPluginChangeFormPlugins.insert(changeForm.formDesc.file);
  }

  affected |= ScanActorWorldOrCellFallbackCandidate(
    changeForm, changeFormDesc, current, renamePlan, stats);

  affected |= ScanDescriptor(changeForm.formDesc, "formDesc", changeFormDesc,
                             current, renamePlan, stats);
  affected |= ScanDescriptor(changeForm.baseDesc, "baseDesc", changeFormDesc,
                             current, renamePlan, stats);
  affected |= ScanDescriptor(changeForm.worldOrCellDesc, "worldOrCellDesc",
                             changeFormDesc, current, renamePlan, stats);
  affected |= ScanDescriptor(changeForm.spawnPoint.cellOrWorldDesc,
                             "spawnPoint_cellOrWorldDesc", changeFormDesc,
                             current, renamePlan, stats);

  for (const auto& templateDesc : changeForm.templateChain) {
    affected |= ScanDescriptor(templateDesc, "templateChain[]",
                               changeFormDesc, current, renamePlan, stats);
  }

  if (changeForm.setNodeTextureSet) {
    for (const auto& [nodeName, textureSetDesc] :
         *changeForm.setNodeTextureSet) {
      (void)nodeName;
      affected |= ScanDescriptor(FormDesc::FromString(textureSetDesc),
                                 "setNodeTextureSet.*", changeFormDesc,
                                 current, renamePlan, stats);
    }
  }

  if (changeForm.factions) {
    for (const auto& faction : *changeForm.factions) {
      affected |= ScanDescriptor(faction.formDesc,
                                 "factions.entries[].formDesc",
                                 changeFormDesc, current, renamePlan, stats);
    }
  }

  affected |= ScanInventory(changeForm.inv, "inv", changeFormDesc, previous,
                            current, stats, validation);
  affected |= ScanInventory(changeForm.equipment.inv, "equipmentDump.inv",
                            changeFormDesc, previous, current, stats,
                            validation);

  affected |= ScanOptionalFormId(changeForm.equipment.leftSpell,
                                 "equipmentDump.leftSpell", changeFormDesc,
                                 previous, current, stats, validation,
                                 kSpellExpectation);
  affected |= ScanOptionalFormId(changeForm.equipment.rightSpell,
                                 "equipmentDump.rightSpell", changeFormDesc,
                                 previous, current, stats, validation,
                                 kSpellExpectation);
  affected |= ScanOptionalFormId(changeForm.equipment.voiceSpell,
                                 "equipmentDump.voiceSpell", changeFormDesc,
                                 previous, current, stats, validation,
                                 kSpellExpectation);
  affected |= ScanOptionalFormId(changeForm.equipment.equippedShout,
                                 "equipmentDump.equippedShout",
                                 changeFormDesc, previous, current, stats,
                                 validation, kShoutExpectation);
  affected |= ScanOptionalFormId(changeForm.equipment.instantSpell,
                                 "equipmentDump.instantSpell", changeFormDesc,
                                 previous, current, stats, validation,
                                 kSpellExpectation);

  affected |= ScanLearnedSpells(changeForm.learnedSpells, changeFormDesc,
                                previous, current, stats, validation);
  affected |= ScanLearnedShouts(changeForm.learnedShouts, changeFormDesc,
                                previous, current, stats, validation);
  affected |= ScanUnlockedWords(changeForm.unlockedWords, changeFormDesc,
                                previous, current, stats, validation);

  affected |= ScanActiveMagicEffects(changeForm.activeMagicEffects,
                                     changeFormDesc, previous, current,
                                     stats, validation);

  affected |= ScanAppearanceDump(changeForm.appearanceDump, changeFormDesc,
                                 previous, current, stats, validation);

  return affected;
}

bool HasUnsafeReferences(const PreflightStats& stats)
{
  return stats.missingPluginReferences > 0 ||
    stats.invalidSlotReferences > 0 || stats.cannotEncodeReferences > 0 ||
    stats.recordMissingReferences > 0 ||
    stats.recordTypeMismatchReferences > 0 ||
    stats.descriptorMissingPluginReferences > 0 ||
    stats.descriptorAmbiguousRenameReferences > 0 ||
    stats.appearanceParseErrors > 0 ||
    stats.actorWorldOrCellFallbackCandidates > 0;
}

bool RequiresMigration(const PreflightStats& stats)
{
  return stats.migratableReferences > 0 ||
    stats.descriptorRenameReferences > 0;
}

nlohmann::json BuildPreflightResult(const PreflightStats& stats,
                                    const DescriptorRenamePlan& renamePlan,
                                    const std::optional<LocationalData>&
                                      teleportPointFallback)
{
  const bool hasUnsafeReferences = HasUnsafeReferences(stats);
  const bool requiresMigration = RequiresMigration(stats);

  auto result = nlohmann::json::object();
  result["status"] = hasUnsafeReferences
    ? "unsafe"
    : (requiresMigration ? "migration-needed" : "no-remap-needed");
  result["requiresMigration"] = requiresMigration;
  result["hasUnsafeReferences"] = hasUnsafeReferences;
  result["changeFormsScanned"] = stats.changeFormsScanned;
  result["affectedChangeForms"] = stats.affectedChangeForms;
  result["missingPluginChangeForms"] = stats.missingPluginChangeForms;
  result["actorWorldOrCellFallbackCandidates"] =
    stats.actorWorldOrCellFallbackCandidates;
  result["skippedReferences"] = stats.skippedReferences;
  result["stableMappingSkippedReferences"] =
    stats.stableMappingSkippedReferences;
  result["checkedReferences"] = stats.checkedReferences;
  result["unchangedReferences"] = stats.unchangedReferences;
  result["migratableReferences"] = stats.migratableReferences;
  result["missingPluginReferences"] = stats.missingPluginReferences;
  result["invalidSlotReferences"] = stats.invalidSlotReferences;
  result["cannotEncodeReferences"] = stats.cannotEncodeReferences;
  result["recordMissingReferences"] = stats.recordMissingReferences;
  result["recordTypeMismatchReferences"] =
    stats.recordTypeMismatchReferences;
  result["descriptorSkippedReferences"] = stats.descriptorSkippedReferences;
  result["descriptorCheckedReferences"] = stats.descriptorCheckedReferences;
  result["descriptorUnchangedReferences"] =
    stats.descriptorUnchangedReferences;
  result["descriptorRenameReferences"] = stats.descriptorRenameReferences;
  result["descriptorMissingPluginReferences"] =
    stats.descriptorMissingPluginReferences;
  result["descriptorAmbiguousRenameReferences"] =
    stats.descriptorAmbiguousRenameReferences;
  result["appearanceParseErrors"] = stats.appearanceParseErrors;

  auto fields = nlohmann::json::array();
  for (const auto& [field, fieldStats] : stats.fields) {
    fields.push_back({ { "field", field },
                       { "skipped", fieldStats.skipped },
                       { "stableMappingSkipped",
                         fieldStats.stableMappingSkipped },
                       { "checked", fieldStats.checked },
                       { "unchanged", fieldStats.unchanged },
                       { "migratable", fieldStats.migratable },
                       { "missingPlugin", fieldStats.missingPlugin },
                       { "invalidSlot", fieldStats.invalidSlot },
                       { "cannotEncode", fieldStats.cannotEncode },
                       { "recordMissing", fieldStats.recordMissing },
                       { "recordTypeMismatch",
                         fieldStats.recordTypeMismatch } });
  }
  result["fields"] = std::move(fields);

  auto descriptorFields = nlohmann::json::array();
  for (const auto& [field, fieldStats] : stats.descriptorFields) {
    descriptorFields.push_back(
      { { "field", field },
        { "skipped", fieldStats.skipped },
        { "checked", fieldStats.checked },
        { "unchanged", fieldStats.unchanged },
        { "renamed", fieldStats.renamed },
        { "missingPlugin", fieldStats.missingPlugin },
        { "ambiguousRename", fieldStats.ambiguousRename } });
  }
  result["descriptorFields"] = std::move(descriptorFields);

  auto descriptorRenameAliases = nlohmann::json::array();
  for (const auto& [_, rename] : renamePlan.byOldKey) {
    descriptorRenameAliases.push_back({ { "oldFilename", rename.oldFilename },
                                        { "newFilename", rename.newFilename },
                                        { "reason", rename.reason } });
  }
  result["descriptorRenameAliases"] = std::move(descriptorRenameAliases);

  auto descriptorAmbiguousRenameCandidates = nlohmann::json::array();
  for (const auto& [oldKey, candidates] : renamePlan.ambiguousByOldKey) {
    descriptorAmbiguousRenameCandidates.push_back(
      { { "oldPluginKey", oldKey }, { "candidates", candidates } });
  }
  result["descriptorAmbiguousRenameCandidates"] =
    std::move(descriptorAmbiguousRenameCandidates);

  auto missingPlugins = nlohmann::json::array();
  for (const auto& plugin : stats.missingPlugins) {
    missingPlugins.push_back(plugin);
  }
  result["missingPlugins"] = std::move(missingPlugins);

  auto descriptorMissingPlugins = nlohmann::json::array();
  for (const auto& plugin : stats.descriptorMissingPlugins) {
    descriptorMissingPlugins.push_back(plugin);
  }
  result["descriptorMissingPlugins"] = std::move(descriptorMissingPlugins);

  auto missingPluginChangeFormPlugins = nlohmann::json::array();
  for (const auto& plugin : stats.missingPluginChangeFormPlugins) {
    missingPluginChangeFormPlugins.push_back(plugin);
  }
  result["missingPluginChangeFormPlugins"] =
    std::move(missingPluginChangeFormPlugins);

  result["deletedMissingPluginChangeForms"] = 0;
  result["prunedMissingPluginReferences"] = 0;
  result["prunedInvalidSlotReferences"] = 0;
  result["prunedMissingPluginDescriptors"] = 0;
  result["repairedActorWorldOrCellFallbacks"] = 0;
  result["teleportPointFallbackAvailable"] = teleportPointFallback.has_value();
  if (teleportPointFallback) {
    result["teleportPointFallback"] = {
      { "pos",
        { teleportPointFallback->pos[0], teleportPointFallback->pos[1],
          teleportPointFallback->pos[2] } },
      { "worldOrCellDesc",
        teleportPointFallback->cellOrWorldDesc.ToString() },
      { "angleZ", teleportPointFallback->rot[2] }
    };
  }
  result["examples"] = stats.examples;
  result["descriptorExamples"] = stats.descriptorExamples;

  return result;
}

void AddRemediationStatsToResult(nlohmann::json& result,
                                 const RemediationStats& remediationStats)
{
  result["deletedMissingPluginChangeForms"] =
    remediationStats.deletedMissingPluginChangeForms;
  result["prunedMissingPluginReferences"] =
    remediationStats.prunedMissingPluginReferences;
  result["prunedInvalidSlotReferences"] =
    remediationStats.prunedInvalidSlotReferences;
  result["prunedMissingPluginDescriptors"] =
    remediationStats.prunedMissingPluginDescriptors;
  result["repairedActorWorldOrCellFallbacks"] =
    remediationStats.repairedActorWorldOrCellFallbacks;
}

size_t FlushMigrationChunk(
  std::shared_ptr<ChangeFormDatabase> db,
  std::vector<std::optional<MpChangeForm>>& changeForms)
{
  if (changeForms.empty()) {
    return 0;
  }

  const auto upserted = db->Upsert(std::move(changeForms));
  changeForms = {};
  changeForms.reserve(kMigrationChunkSize);
  return upserted;
}

MigrationOptions ParseMigrationOptions(const nlohmann::json& optionsJson)
{
  MigrationOptions options;
  if (!optionsJson.is_object()) {
    return options;
  }

  options.deleteMissingPluginChangeForms =
    optionsJson.value("deleteMissingPluginChangeForms", false);
  options.pruneMissingPluginReferences =
    optionsJson.value("pruneMissingPluginReferences", false);
  options.repairActorWorldOrCellFallback =
    optionsJson.value("repairActorWorldOrCellFallback", false);
  return options;
}

std::vector<std::filesystem::path> BuildEspmPluginPaths(
  const nlohmann::json& settings)
{
  if (!settings.contains("dataDir") || settings.at("dataDir").is_null()) {
    throw std::runtime_error("missing 'dataDir' in server-settings.json");
  }

  const std::filesystem::path dataDir =
    settings.at("dataDir").get<std::string>();
  std::vector<std::filesystem::path> pluginPaths = {
    dataDir / "Skyrim.esm",      dataDir / "Update.esm",
    dataDir / "Dawnguard.esm",   dataDir / "HearthFires.esm",
    dataDir / "Dragonborn.esm"
  };

  if (settings.contains("loadOrder") && settings.at("loadOrder").is_array()) {
    pluginPaths.clear();
    for (const auto& loadOrderEntry : settings.at("loadOrder")) {
      std::filesystem::path loadOrderElement =
        loadOrderEntry.get<std::string>();
      if (loadOrderElement.is_absolute()) {
        pluginPaths.push_back(loadOrderElement);
      } else {
        pluginPaths.push_back(dataDir / loadOrderElement);
      }
    }
  }

  return pluginPaths;
}

bool ScanChangeFormWithRemediation(
  const MpChangeForm& changeForm, const SnapshotIndex& previous,
  const SnapshotIndex& current, const DescriptorRenamePlan& renamePlan,
  const MigrationOptions& options, PreflightStats& stats,
  RemediationStats& remediationStats,
  const std::optional<LocationalData>& teleportPointFallback,
  const RecordTypeValidationContext& validation)
{
  if (ShouldDeleteMissingPluginChangeForm(changeForm, current, renamePlan,
                                          options)) {
    ++remediationStats.deletedMissingPluginChangeForms;
    return true;
  }

  auto remediatedChangeForm = changeForm;
  const bool repaired = RepairActorWorldOrCellFallback(
    remediatedChangeForm, current, renamePlan, options, teleportPointFallback,
    remediationStats);
  const bool pruned = PruneUnresolvableReferences(
    remediatedChangeForm, previous, current, renamePlan, options,
    remediationStats);
  return ScanChangeForm(remediatedChangeForm, previous, current, renamePlan,
                        stats, validation) ||
    pruned || repaired;
}

void ScanDatabaseForLoadOrderMigration(
  std::shared_ptr<ChangeFormDatabase> db, const SnapshotIndex& previous,
  const SnapshotIndex& current, const DescriptorRenamePlan& renamePlan,
  const MigrationOptions& options, PreflightStats& stats,
  RemediationStats& remediationStats,
  const std::optional<LocationalData>& teleportPointFallback,
  const RecordTypeValidationContext& validation)
{
  const bool wantsRemediation =
    options.deleteMissingPluginChangeForms ||
    options.pruneMissingPluginReferences ||
    options.repairActorWorldOrCellFallback;

  db->Iterate(
    [&](const MpChangeForm& changeForm) {
      ++stats.changeFormsScanned;
      const bool affected = wantsRemediation
        ? ScanChangeFormWithRemediation(changeForm, previous, current,
                                        renamePlan, options, stats,
                                        remediationStats,
                                        teleportPointFallback, validation)
        : ScanChangeForm(changeForm, previous, current, renamePlan, stats,
                         validation);
      if (affected) {
        ++stats.affectedChangeForms;
      }
    },
    std::nullopt);
}

nlohmann::json RunDatabaseLoadOrderMigrationImpl(
  nlohmann::json settings, const nlohmann::json& previousSnapshot,
  const nlohmann::json& currentSnapshot, bool apply,
  MigrationOptions options = {})
{
  if (settings.value("databaseDriver", std::string("file")) == "migration") {
    throw std::runtime_error(
      "database load-order migration cannot be run with databaseDriver="
      "migration because that driver mutates databases during construction");
  }

  auto previous = BuildSnapshotIndex(previousSnapshot);
  const auto current = BuildSnapshotIndex(currentSnapshot);
  MarkStableMappingSlots(previous, current);
  const auto renamePlan = BuildDescriptorRenamePlan(previous, current);
  const auto teleportPointFallback =
    ParseTeleportPointFallback(settings, current, renamePlan);
  const auto pluginPaths = BuildEspmPluginPaths(settings);
  std::unique_ptr<espm::Loader> currentEspm;
  {
    ScopedSpdlogLevel suppressInfoLogs(spdlog::level::warn);
    currentEspm = std::make_unique<espm::Loader>(pluginPaths);
  }
  const RecordTypeValidationContext validation{ &currentEspm->GetBrowser() };
  auto db = DatabaseFactory::Create(settings, GetPreflightLogger());
  const auto databaseDriver =
    settings.value("databaseDriver", std::string("file"));

  PreflightStats stats;
  RemediationStats remediationPreview;
  ScanDatabaseForLoadOrderMigration(db, previous, current, renamePlan, {},
                                    stats, remediationPreview,
                                    teleportPointFallback, validation);

  auto result =
    BuildPreflightResult(stats, renamePlan, teleportPointFallback);
  result["applyRequested"] = apply;
  result["applied"] = false;
  result["updatedChangeForms"] = 0;
  result["deletedOldChangeForms"] = 0;

  if (!apply) {
    return result;
  }

  const bool wantsRemediation =
    options.deleteMissingPluginChangeForms ||
    options.pruneMissingPluginReferences ||
    options.repairActorWorldOrCellFallback;
  PreflightStats effectiveStats = stats;
  RemediationStats effectiveRemediationStats;

  if (wantsRemediation) {
    effectiveStats = {};
    ScanDatabaseForLoadOrderMigration(db, previous, current, renamePlan,
                                       options, effectiveStats,
                                       effectiveRemediationStats,
                                       teleportPointFallback, validation);
    result =
      BuildPreflightResult(effectiveStats, renamePlan, teleportPointFallback);
    result["applyRequested"] = apply;
    result["applied"] = false;
    result["updatedChangeForms"] = 0;
    result["deletedOldChangeForms"] = 0;
    AddRemediationStatsToResult(result, effectiveRemediationStats);
  }

  if (HasUnsafeReferences(effectiveStats)) {
    return result;
  }

  if (!RequiresMigration(effectiveStats) &&
      !effectiveRemediationStats.HasWork()) {
    result["status"] = "accepted";
    result["applied"] = true;
    return result;
  }

  std::vector<std::optional<MpChangeForm>> changeFormsToUpsert;
  changeFormsToUpsert.reserve(kMigrationChunkSize);
  std::set<FormDesc> oldFormDescsToDelete;
  size_t upserted = 0;
  PreflightStats applyStats;
  RemediationStats appliedRemediationStats;

  db->Iterate(
    [&](const MpChangeForm& changeForm) {
      if (ShouldDeleteMissingPluginChangeForm(changeForm, current, renamePlan,
                                              options)) {
        ++appliedRemediationStats.deletedMissingPluginChangeForms;
        oldFormDescsToDelete.insert(changeForm.formDesc);
        return;
      }

      auto migratedChangeForm = changeForm;
      const bool repaired = RepairActorWorldOrCellFallback(
        migratedChangeForm, current, renamePlan, options, teleportPointFallback,
        appliedRemediationStats);
      const bool pruned = PruneUnresolvableReferences(
        migratedChangeForm, previous, current, renamePlan, options,
        appliedRemediationStats);
      const auto oldFormDesc = changeForm.formDesc;
      const bool affected = ProcessChangeForm(
        migratedChangeForm, previous, current, renamePlan, applyStats, true,
        validation);
      if (!affected && !pruned && !repaired) {
        return;
      }

      const auto& newFormDesc = migratedChangeForm.formDesc;
      const bool fileDbCaseOnlyRename = databaseDriver == "file" &&
        ToLower(oldFormDesc.ToString('_')) == ToLower(newFormDesc.ToString('_'));
      if (oldFormDesc != newFormDesc && !fileDbCaseOnlyRename) {
        oldFormDescsToDelete.insert(oldFormDesc);
      }

      changeFormsToUpsert.emplace_back(std::move(migratedChangeForm));
      if (changeFormsToUpsert.size() >= kMigrationChunkSize) {
        upserted += FlushMigrationChunk(db, changeFormsToUpsert);
      }
    },
    std::nullopt);

  upserted += FlushMigrationChunk(db, changeFormsToUpsert);

  std::vector<FormDesc> oldFormDescs(oldFormDescsToDelete.begin(),
                                     oldFormDescsToDelete.end());
  const auto deleted = db->Delete(oldFormDescs);

  result["status"] = "applied";
  result["applied"] = true;
  result["updatedChangeForms"] = upserted;
  result["deletedOldChangeForms"] = deleted;
  AddRemediationStatsToResult(result, appliedRemediationStats);
  return result;
}

}

Napi::Value ScampServer::RunDatabaseLoadOrderMigrationPreflight(
  const Napi::CallbackInfo& info)
{
  auto env = info.Env();

  try {
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
        !info[2].IsString()) {
      throw std::runtime_error(
        "runDatabaseLoadOrderMigrationPreflight expects settings, previous "
        "snapshot and current snapshot JSON strings");
    }

    auto settings = nlohmann::json::parse(
      static_cast<std::string>(info[0].As<Napi::String>()));
    const auto previousSnapshot = nlohmann::json::parse(
      static_cast<std::string>(info[1].As<Napi::String>()));
    const auto currentSnapshot = nlohmann::json::parse(
      static_cast<std::string>(info[2].As<Napi::String>()));

    return Napi::String::New(env,
                             RunDatabaseLoadOrderMigrationImpl(
                               settings, previousSnapshot, currentSnapshot,
                               false)
                               .dump());
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value ScampServer::RunDatabaseLoadOrderMigration(
  const Napi::CallbackInfo& info)
{
  auto env = info.Env();

  try {
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
        !info[2].IsString()) {
      throw std::runtime_error(
        "runDatabaseLoadOrderMigration expects settings, previous snapshot "
        "and current snapshot JSON strings");
    }

    auto settings = nlohmann::json::parse(
      static_cast<std::string>(info[0].As<Napi::String>()));
    const auto previousSnapshot = nlohmann::json::parse(
      static_cast<std::string>(info[1].As<Napi::String>()));
    const auto currentSnapshot = nlohmann::json::parse(
      static_cast<std::string>(info[2].As<Napi::String>()));
    const auto options = info.Length() >= 4 && info[3].IsString()
      ? ParseMigrationOptions(nlohmann::json::parse(
          static_cast<std::string>(info[3].As<Napi::String>())))
      : MigrationOptions{};

    return Napi::String::New(
      env,
      RunDatabaseLoadOrderMigrationImpl(settings, previousSnapshot,
                                        currentSnapshot, true, options)
        .dump());
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}
