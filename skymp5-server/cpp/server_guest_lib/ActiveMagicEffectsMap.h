#pragma once
#include "libespm/espm.h"
#include <chrono>
#include <functional>
#include <nlohmann/json.hpp>
#include <optional>
#include <simdjson.h>
#include <unordered_map>

class ActiveMagicEffectsMap
{
public:
  struct Entry
  {
    uint32_t timerId = -1;
    espm::Effects::Effect data;
    std::chrono::system_clock::time_point endTime;
  };

public:
  static ActiveMagicEffectsMap FromJson(const simdjson::dom::element& effects);

public:
  template <typename T>
  void Add(espm::ActorValue actorValue, T&& entry)
  {
    auto it = effects.find(actorValue);
    effects[actorValue] = std::forward<T>(entry);
  }

  std::vector<espm::Effects::Effect> GetAllEffects() const noexcept;

  std::optional<std::reference_wrapper<const Entry>> Get(
    espm::ActorValue actorValue) const noexcept;
  void Remove(espm::ActorValue actorValue) noexcept;
  void Clear() noexcept;
  template <typename Visitor>
  void ForEachEffect(Visitor&& visitor) const
  {
    for (const auto& [_, effectEntry] : effects) {
      visitor(effectEntry.data);
    }
  }
  template <typename Predicate>
  size_t RemoveEffectsIf(Predicate&& predicate)
  {
    size_t removed = 0;
    for (auto it = effects.begin(); it != effects.end();) {
      if (predicate(it->second.data)) {
        it = effects.erase(it);
        ++removed;
      } else {
        ++it;
      }
    }
    return removed;
  }
  void TransformEffectIds(
    const std::function<uint32_t(uint32_t)>& transform);
  bool Has(espm::ActorValue actorValue) const noexcept;
  [[nodiscard]] bool Empty() const noexcept;
  nlohmann::json::array_t ToJson() const;

private:
  std::unordered_map<espm::ActorValue, Entry> effects;
};
