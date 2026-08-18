#pragma once
#include <array>
#include <cstddef>
#include <cstdint>

namespace espm {

struct IdMapping
{
  enum class TargetKind : uint8_t
  {
    Invalid,
    Full,
    Light
  };

  struct Target
  {
    TargetKind kind = TargetKind::Invalid;
    uint16_t index = 0;

    Target& operator=(uint16_t fullIndex) noexcept
    {
      kind = TargetKind::Full;
      index = fullIndex;
      return *this;
    }
  };

  void fill(uint16_t value) noexcept
  {
    for (auto& target : fullSlots) {
      if (value == 0xff) {
        target = {};
      } else {
        target = value;
      }
    }
    for (auto& target : lightSlots) {
      target = {};
    }
  }

  Target& operator[](size_t index) noexcept { return fullSlots[index]; }
  const Target& operator[](size_t index) const noexcept
  {
    return fullSlots[index];
  }

  void SetFull(size_t slot, uint16_t index) noexcept
  {
    fullSlots[slot].kind = TargetKind::Full;
    fullSlots[slot].index = index;
  }

  void SetLight(size_t slot, uint16_t index) noexcept
  {
    fullSlots[slot].kind = TargetKind::Light;
    fullSlots[slot].index = index;
  }

  void SetLightRaw(size_t lightIndex, uint16_t rawSlot) noexcept
  {
    lightSlots[lightIndex].kind = TargetKind::Full;
    lightSlots[lightIndex].index = rawSlot;
  }

  const Target& GetFull(size_t slot) const noexcept { return fullSlots[slot]; }
  const Target& GetLight(size_t lightIndex) const noexcept
  {
    return lightSlots[lightIndex];
  }

private:
  std::array<Target, 256> fullSlots{};
  std::array<Target, 4096> lightSlots{};
};

}
