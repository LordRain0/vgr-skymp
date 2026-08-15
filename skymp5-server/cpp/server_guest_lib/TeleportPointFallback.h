#pragma once
#include "MsgTransform.h"
#include "WorldState.h"
#include <optional>

inline std::optional<MsgTransform> GetTeleportPointFallbackTransform(
  const WorldState& worldState)
{
  if (!worldState.teleportPointFallback) {
    return std::nullopt;
  }

  const auto& fallback = *worldState.teleportPointFallback;
  MsgTransform transform;
  transform.pos = { fallback.pos.x, fallback.pos.y, fallback.pos.z };
  transform.rot = { fallback.rot.x, fallback.rot.y, fallback.rot.z };
  transform.worldOrCell =
    fallback.cellOrWorldDesc.ToFormId(worldState.espmFiles);
  return transform;
}
