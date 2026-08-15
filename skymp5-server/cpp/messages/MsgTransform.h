#pragma once
#include <array>
#include <cstdint>

struct MsgTransform
{
  template <class Archive>
  void Serialize(Archive& archive)
  {
    archive.Serialize("worldOrCell", worldOrCell)
      .Serialize("pos", pos)
      .Serialize("rot", rot);
  }

  uint32_t worldOrCell = 0;
  std::array<float, 3> pos = { 0.f, 0.f, 0.f };
  std::array<float, 3> rot = { 0.f, 0.f, 0.f };
};
