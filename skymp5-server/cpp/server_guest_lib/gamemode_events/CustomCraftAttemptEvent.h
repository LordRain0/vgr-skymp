#pragma once
#include "GameModeEvent.h"

#include "Inventory.h"

// Fired when a client-reported craft matches no COBJ recipe (vanilla alchemy
// labs and other non-COBJ stations produce dynamic forms the server can't
// resolve). Carries the consumed inputs so gamemode JS can re-derive and grant
// a canonical result (see vgr_alchemy.js). Pure notification: no engine-side
// effect on success or block.
class CustomCraftAttemptEvent : public GameModeEvent
{
public:
  CustomCraftAttemptEvent(uint32_t actorId_, uint32_t workbenchBaseId_,
                          const Inventory& inputObjects_);

  const char* GetName() const override;

  std::string GetArgumentsJsonArray() const override;

private:
  void OnFireSuccess(WorldState* worldState) override;

  uint32_t actorId = 0;
  uint32_t workbenchBaseId = 0;
  std::string inputsJson;
};
