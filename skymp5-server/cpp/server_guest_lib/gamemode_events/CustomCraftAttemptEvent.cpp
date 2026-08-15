#include "CustomCraftAttemptEvent.h"

CustomCraftAttemptEvent::CustomCraftAttemptEvent(uint32_t actorId_,
                                                uint32_t workbenchBaseId_,
                                                const Inventory& inputObjects_)
  : actorId(actorId_)
  , workbenchBaseId(workbenchBaseId_)
  , inputsJson(inputObjects_.ToJson().dump())
{
}

const char* CustomCraftAttemptEvent::GetName() const
{
  return "onCustomCraftAttempt";
}

std::string CustomCraftAttemptEvent::GetArgumentsJsonArray() const
{
  std::string result;
  result += "[";
  result += std::to_string(actorId);
  result += ",";
  result += std::to_string(workbenchBaseId);
  result += ",";
  result += inputsJson; // {"entries":[{"baseId":...,"count":...}]}
  result += "]";
  return result;
}

void CustomCraftAttemptEvent::OnFireSuccess(WorldState*)
{
  // Notification-only event: gamemode JS owns validation, ingredient
  // deduction, and the canonical item grant.
}
