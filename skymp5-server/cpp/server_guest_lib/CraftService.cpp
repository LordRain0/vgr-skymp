#include "CraftService.h"

#include "ConditionsEvaluator.h"
#include "MpActor.h"
#include "PartOne.h"
#include "RawMessageData.h"
#include "WorldState.h"
#include "gamemode_events/CraftEvent.h"
#include "gamemode_events/CustomCraftAttemptEvent.h"
#include <algorithm>
#include <fmt/format.h>
#include <fmt/ranges.h>
#include <spdlog/spdlog.h>
#include <vector>

namespace {
uint32_t ParseConditionParameter(const std::string& parameter)
{
  const char* str = parameter.c_str();
  char* end = nullptr;
  int base = 10;

  if (parameter.length() > 2 && str[0] == '0') {
    if (str[1] == 'x' || str[1] == 'X') {
      base = 16;
    } else if (str[1] == 'b' || str[1] == 'B') {
      base = 2;
      str += 2;
    }
  }

  return static_cast<uint32_t>(std::strtoul(str, &end, base));
}

void MapConditionFormIdParameter(const espm::LookupResult& lookupRes,
                                 std::string& parameter)
{
  const uint32_t rawId = ParseConditionParameter(parameter);
  if (!rawId) {
    return;
  }

  const uint32_t mappedId = lookupRes.ToGlobalId(rawId);
  if (!mappedId || mappedId == rawId || !lookupRes.parent) {
    return;
  }

  if (!lookupRes.parent->LookupById(mappedId).rec) {
    return;
  }

  parameter = fmt::format("{:#x}", mappedId);
}
}

CraftService::CraftService(PartOne& partOne_)
  : partOne(partOne_)
{
}

void CraftService::OnCraftItem(const RawMessageData& rawMsgData,
                               const Inventory& inputObjects,
                               uint32_t workbenchId, uint32_t resultObjectId)
{
  auto& workbench =
    partOne.worldState.GetFormAt<MpObjectReference>(workbenchId);

  auto& br = partOne.worldState.GetEspm().GetBrowser();
  auto& cache = partOne.worldState.GetEspmCache();
  auto workbenchBase = br.LookupById(workbench.GetBaseId());

  spdlog::info("User {} tries to craft {:#x} on workbench {:#x}",
               rawMsgData.userId, resultObjectId, workbenchId);

  if (!workbenchBase.rec) {
    return spdlog::error("Workbench ref without base object {:x}",
                         workbench.GetFormId());
  }

  bool isFurnitureOrActivator =
    workbenchBase.rec->GetType() == "FURN" ||
    workbenchBase.rec->GetType() == "ACTI";
  if (!isFurnitureOrActivator) {
    return spdlog::error("Unable to use {} as workbench",
                         workbenchBase.rec->GetType().ToString());
  }

  MpActor* me = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!me) {
    return spdlog::error("Unable to craft without Actor attached");
  }

  std::vector<uint32_t> workbenchKeywordIds =
    workbenchBase.rec->GetKeywordIds(cache);

  auto recipesList =
    FindRecipe(me, workbenchKeywordIds, br, inputObjects, resultObjectId);

  if (recipesList.empty()) {
    // Non-COBJ stations (alchemy labs, etc.) produce dynamic forms the server
    // can't resolve, so no recipe ever matches. Forward the attempt with its
    // inputs to gamemode JS, which can grant a canonical static result
    // (see vgr_alchemy.js onCustomCraftAttempt).
    spdlog::info("Recipe not found, firing onCustomCraftAttempt: "
                 "inputObjects={}, workbenchId={:#x}, resultObjectId={:#x}",
                 inputObjects.ToJson().dump(), workbenchId, resultObjectId);
    CustomCraftAttemptEvent event(me->GetFormId(), workbench.GetBaseId(),
                                  inputObjects);
    event.Fire(&partOne.worldState);
    return;
  }

  if (recipesList.size() > 1) {
    spdlog::warn("Found more than 1 recipe ({}), using the 1st one",
                 recipesList.size());
  }

  auto recipe = espm::Convert<espm::COBJ>(recipesList[0].rec);
  if (!recipe) {
    return spdlog::error("Selected craft recipe is not a COBJ record");
  }

  UseCraftRecipe(me, recipe, cache, br, recipesList[0].fileIdx);
}

bool CraftService::RecipeItemsMatch(const espm::LookupResult& lookupRes,
                                    const Inventory& inputObjects,
                                    uint32_t resultObjectId)
{
  auto recipe = espm::Convert<espm::COBJ>(lookupRes.rec);
  if (!recipe) {
    return false;
  }

  espm::CompressedFieldsCache dummyCache;
  auto recipeData = recipe->GetData(dummyCache);

  enum
  {
    ArmorTable = 0xadb78,
    SharpeningWheel = 0x88108
  };
  const bool isTemper = recipeData.benchKeywordId == ArmorTable ||
    recipeData.benchKeywordId == SharpeningWheel;
  if (isTemper) {
    return false;
  }

  auto thisInputObjects = recipeData.inputObjects;
  for (auto& entry : thisInputObjects) {
    auto formId = lookupRes.ToGlobalId(entry.formId);
    if (inputObjects.GetItemCount(formId) != entry.count) {
      return false;
    }
  }
  auto formId = lookupRes.ToGlobalId(recipeData.outputObjectFormId);
  if (formId != resultObjectId) {
    return false;
  }
  return true;
}

std::vector<espm::LookupResult> CraftService::FindRecipe(
  std::optional<MpActor*> me,
  std::optional<std::vector<uint32_t>> workbenchKeywordIds,
  const espm::CombineBrowser& br, const Inventory& inputObjects,
  uint32_t resultObjectId)
{
  const auto& allRecipes = br.GetDistinctRecordsByType(espm::COBJ::kType);

  std::vector<espm::LookupResult> candidatesConsideredUsable;

  for (auto& recipe : allRecipes) {
    if (!RecipeItemsMatch(recipe, inputObjects, resultObjectId)) {
      continue;
    }

    spdlog::info("CraftService::FindRecipe - Recipe candidate found: {:x}",
                 recipe.ToGlobalId(recipe.rec->GetId()));

    const bool canBeUsed =
      ConsiderRecipeCandidate(me, workbenchKeywordIds, recipe);
    if (canBeUsed) {
      candidatesConsideredUsable.push_back(recipe);
      spdlog::info("CraftService::FindRecipe - Recipe candidate usable");
    } else {
      spdlog::info("CraftService::FindRecipe - Recipe candidate not usable");
    }
  }

  return candidatesConsideredUsable;
}

bool CraftService::ConsiderRecipeCandidate(
  std::optional<MpActor*> me,
  std::optional<std::vector<uint32_t>> workbenchKeywordIds,
  const espm::LookupResult& lookupRes)
{
  auto cobj = espm::Convert<espm::COBJ>(lookupRes.rec);
  if (!cobj) {
    return false;
  }
  auto cobjData = cobj->GetData(cache);

  bool finalConsiderationResult = true;

  if (me.has_value()) {
    bool evalRes = EvaluateCraftRecipeConditions(*me, lookupRes, cobjData);
    if (!evalRes) {
      spdlog::info("CraftService::ConsiderRecipeCandidate - Craft recipe "
                   "conditions are not met");
      finalConsiderationResult = false;
    }
  } else {
    spdlog::info("CraftService::ConsiderRecipeCandidate - Actor not "
                 "specified, skipping conditions check");
  }

  if (workbenchKeywordIds.has_value()) {
    auto recipeBenchKeywordId = lookupRes.ToGlobalId(cobjData.benchKeywordId);

    // Note: In the original game, setting the benchmark keyword to NONE
    // removes the recipe from all crafting stations.

    bool includes =
      std::any_of(workbenchKeywordIds->begin(), workbenchKeywordIds->end(),
                  [&](uint32_t id) { return id == recipeBenchKeywordId; });

    if (!includes) {
      std::vector<std::string> hexIds;
      hexIds.reserve(workbenchKeywordIds->size());
      for (auto id : *workbenchKeywordIds) {
        hexIds.push_back(fmt::format("{:x}", id));
      }

      spdlog::info("CraftService::ConsiderRecipeCandidate - Craft recipe "
                   "workbench keywords don't match: recipe one {:x} is not in "
                   "workbench ids {}",
                   recipeBenchKeywordId, fmt::join(hexIds, ", "));
      finalConsiderationResult = false;
    }

  } else {
    spdlog::info("CraftService::ConsiderRecipeCandidate - Workbench keyword "
                 "id not specified, skipping bench keyword id check");
  }

  return finalConsiderationResult;
}

void CraftService::UseCraftRecipe(MpActor* me, const espm::COBJ* recipeUsed,
                                  espm::CompressedFieldsCache& cache,
                                  const espm::CombineBrowser& br, int espmIdx)
{
  auto recipeData = recipeUsed->GetData(cache);
  auto mapping = br.GetCombMapping(espmIdx);

  spdlog::info("Using craft recipe with EDID {} from espm file with index {}",
               recipeUsed->GetEditorId(cache), espmIdx);

  std::vector<Inventory::Entry> entries;
  for (auto& entry : recipeData.inputObjects) {
    auto formId = espm::utils::GetMappedId(entry.formId, *mapping);
    entries.push_back({ formId, entry.count });
  }

  auto outputFormId =
    espm::utils::GetMappedId(recipeData.outputObjectFormId, *mapping);

  if (spdlog::should_log(spdlog::level::info)) {
    std::string s = fmt::format("User formId={:#x} crafted", me->GetFormId());
    for (const auto& entry : entries) {
      s += fmt::format(" -{:#x} x{}", entry.baseId, entry.count);
    }
    s += fmt::format(" +{:#x} x{}", outputFormId, recipeData.outputCount);
    spdlog::info("{}", s);
  }

  auto recipeId = espm::utils::GetMappedId(recipeUsed->GetId(), *mapping);

  CraftEvent craftEvent(me, outputFormId, recipeData.outputCount, recipeId,
                        entries);

  craftEvent.Fire(me->GetParent());
}

bool CraftService::EvaluateCraftRecipeConditions(
  MpActor* me, const espm::LookupResult& lookupRes,
  const espm::COBJ::Data& recipeData)
{
  std::vector<Condition> conditions;
  std::transform(recipeData.conditions.begin(), recipeData.conditions.end(),
                 std::back_inserter(conditions), [&](const auto& ctda) {
                   auto condition = Condition::FromCtda(ctda);
                   MapConditionFormIdParameter(lookupRes,
                                               condition.parameter1);
                   MapConditionFormIdParameter(lookupRes,
                                               condition.parameter2);
                   return condition;
                 });

  // TODO: aggressor and target terms are not relevant for crafting
  const MpActor& aggressor = *me;
  const MpActor& target = *me;

  bool evalRes_ = false;

  auto callback = [&](bool evalRes, std::vector<std::string>& strings) {
    evalRes_ = evalRes;

    if (!strings.empty()) {
      if (evalRes) {
        strings.insert(strings.begin(),
                       fmt::format("EvaluateConditions result is true"));
      } else {
        strings.insert(strings.begin(),
                       fmt::format("EvaluateConditions result is false"));
      }
    }
  };

  static const ConditionsEvaluatorSettings kDefaultSettings;

  static const ConditionFunctionMap kEmptyMap;

  auto worldState = me->GetParent();

  const ConditionsEvaluatorSettings& settings =
    worldState ? worldState->conditionsEvaluatorSettings : kDefaultSettings;

  const ConditionFunctionMap& conditionFunctionMap =
    worldState ? worldState->conditionFunctionMap : kEmptyMap;

  ConditionsEvaluator::EvaluateConditions(
    conditionFunctionMap, settings, ConditionsEvaluatorCaller::kCraft,
    conditions, aggressor, target, callback);

  return evalRes_;
}
