#pragma once
#include "ActiveMagicEffectsMap.h"
#include "ActorValues.h"
#include "Appearance.h"
#include "DynamicFields.h"
#include "Equipment.h"
#include "Faction.h"
#include "FormDesc.h"
#include "Inventory.h"
#include "LocationalData.h"
#include "NiPoint3.h"
#include "Quest.h"
#include <cstdint>
#include <map>
#include <optional>
#include <ostream>
#include <set>
#include <string>
#include <tuple>
#include <vector>

class MpObjectReference;
class WorldState;

struct LearnedSpells
{
  using Data = std::set<uint32_t>;

  void LearnSpell(Data::key_type baseId);

  void ForgetSpell(Data::key_type baseId);

  [[nodiscard]] size_t Count() const noexcept;

  [[nodiscard]] bool IsSpellLearned(Data::key_type baseId) const;

  template <typename Visitor>
  void ForEachSpell(Visitor&& visitor) const
  {
    for (auto spellId : _learnedSpellIds) {
      visitor(spellId);
    }
  }

  std::vector<Data::key_type> GetLearnedSpells() const;

  friend bool operator==(const LearnedSpells& lhs, const LearnedSpells& rhs)
  {
    return lhs._learnedSpellIds == rhs._learnedSpellIds;
  }

  friend bool operator!=(const LearnedSpells& lhs, const LearnedSpells& rhs)
  {
    return !(lhs == rhs);
  }

  friend bool operator<(const LearnedSpells& lhs, const LearnedSpells& rhs)
  {
    return lhs._learnedSpellIds < rhs._learnedSpellIds;
  }

private:
  Data _learnedSpellIds{};
};

struct LearnedShouts
{
  using Data = std::set<uint32_t>;

  void LearnShout(Data::key_type baseId);

  void ForgetShout(Data::key_type baseId);

  [[nodiscard]] size_t Count() const noexcept;

  [[nodiscard]] bool IsShoutLearned(Data::key_type baseId) const;

  template <typename Visitor>
  void ForEachShout(Visitor&& visitor) const
  {
    for (auto shoutId : _learnedShoutIds) {
      visitor(shoutId);
    }
  }

  std::vector<Data::key_type> GetLearnedShouts() const;

  friend bool operator==(const LearnedShouts& lhs, const LearnedShouts& rhs)
  {
    return lhs._learnedShoutIds == rhs._learnedShoutIds;
  }

  friend bool operator!=(const LearnedShouts& lhs, const LearnedShouts& rhs)
  {
    return !(lhs == rhs);
  }

  friend bool operator<(const LearnedShouts& lhs, const LearnedShouts& rhs)
  {
    return lhs._learnedShoutIds < rhs._learnedShoutIds;
  }

private:
  Data _learnedShoutIds{};
};

struct UnlockedWords
{
  using Data = std::set<uint32_t>;

  void UnlockWord(Data::key_type baseId);

  void ForgetWord(Data::key_type baseId);

  [[nodiscard]] size_t Count() const noexcept;

  [[nodiscard]] bool IsWordUnlocked(Data::key_type baseId) const;

  template <typename Visitor>
  void ForEachWord(Visitor&& visitor) const
  {
    for (auto wordId : _unlockedWordIds) {
      visitor(wordId);
    }
  }

  std::vector<Data::key_type> GetUnlockedWords() const;

  friend bool operator==(const UnlockedWords& lhs, const UnlockedWords& rhs)
  {
    return lhs._unlockedWordIds == rhs._unlockedWordIds;
  }

  friend bool operator!=(const UnlockedWords& lhs, const UnlockedWords& rhs)
  {
    return !(lhs == rhs);
  }

  friend bool operator<(const UnlockedWords& lhs, const UnlockedWords& rhs)
  {
    return lhs._unlockedWordIds < rhs._unlockedWordIds;
  }

private:
  Data _unlockedWordIds{};
};

class MpChangeFormREFR
{
public:
  enum RecType
  {
    REFR = 0,
    ACHR = 1,
  };

  int recType = RecType::REFR;
  FormDesc formDesc;
  FormDesc baseDesc;
  NiPoint3 position = { 0, 0, 0 };
  NiPoint3 angle = { 0, 0, 0 };
  FormDesc worldOrCellDesc;
  Inventory inv;
  LearnedSpells learnedSpells;
  LearnedShouts learnedShouts;
  UnlockedWords unlockedWords;

  bool isHarvested = false;
  bool isOpen = false;
  bool baseContainerAdded = false;
  uint64_t nextRelootDatetime = 0;
  bool isDisabled = false;
  int32_t profileId = -1;
  bool isDeleted = false;
  uint32_t count = 0;

  bool isRaceMenuOpen = false;
  bool isDead = false;
  ActiveMagicEffectsMap activeMagicEffects;
  bool consoleCommandsAllowed = false;

  // 'appearanceDump' can be empty. it means nullopt.
  // "unexisting" appearance and appearance with zero entries are different
  // values in skymp due to poor design
  std::string appearanceDump;

  Equipment equipment;

  // TODO: inconsistency! save not only percentages but whole structure OR
  // have only percentages in change form struct
  ActorValues actorValues;

  float healthRespawnPercentage = 1.f;
  float magickaRespawnPercentage = 1.f;
  float staminaRespawnPercentage = 1.f;

  // Used only for player characters. See GetSpawnPoint
  LocationalData spawnPoint = { { 133857, -61130, 14662 },
                                { 0.f, 0.f, 72.f },
                                FormDesc::Tamriel() };

  float spawnDelay = 25.0f;

  std::vector<FormDesc> templateChain;

  // Used for PlayAnimation (object reference)
  std::optional<std::string> lastAnimation;

  // Used for SetNodeTextureSet (node, texture set desc)
  std::optional<std::map<std::string, std::string>> setNodeTextureSet;

  // Used for SetNodeScale (node, scale value)
  std::optional<std::map<std::string, float>> setNodeScale;

  // Used for SetDisplayName (object reference)
  std::optional<std::string> displayName;

  // Used for Faction (FACT) synchronization
  std::optional<std::vector<Faction>> factions;

  // Used for Quest (QUST) synchronization
  std::optional<std::vector<Quest>> quests;

  // Please update 'ActorTest.cpp' when adding new Actor-related rows

  DynamicFields dynamicFields;

  auto ToTuple() const
  {
    return std::make_tuple(
      recType, formDesc, baseDesc, position.x, position.y, position.z, angle.x,
      angle.y, angle.z, worldOrCellDesc, inv.ToJson(), isHarvested, isOpen,
      baseContainerAdded, nextRelootDatetime, isDisabled, profileId, isDeleted,
      count, isRaceMenuOpen, isDead, consoleCommandsAllowed, appearanceDump,
      equipment.ToJson(), actorValues.ToTuple(), healthRespawnPercentage,
      magickaRespawnPercentage, staminaRespawnPercentage, spawnPoint,
      dynamicFields, spawnDelay, learnedSpells, learnedShouts, unlockedWords,
      templateChain, lastAnimation, setNodeTextureSet, setNodeScale,
      displayName);
  }

  static nlohmann::json ToJson(const MpChangeFormREFR& changeForm);
  static MpChangeFormREFR JsonToChangeForm(simdjson::dom::element& element);
};

#define MpChangeForm MpChangeFormREFR

inline bool operator==(const MpChangeFormREFR& lhs,
                       const MpChangeFormREFR& rhs)
{
  return lhs.ToTuple() == rhs.ToTuple();
}

inline bool operator!=(const MpChangeFormREFR& lhs,
                       const MpChangeFormREFR& rhs)
{
  return !(lhs == rhs);
}

inline bool operator<(const MpChangeFormREFR& lhs, const MpChangeFormREFR& rhs)
{
  return lhs.ToTuple() < rhs.ToTuple();
}
