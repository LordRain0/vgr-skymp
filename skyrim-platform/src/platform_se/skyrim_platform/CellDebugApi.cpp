#include "CellDebugApi.h"

#include "RE/B/BGSLightingTemplate.h"
#include "RE/B/BGSMusicType.h"
#include "RE/C/Color.h"
#include "RE/E/ExtraCellImageSpace.h"
#include "RE/E/ExtraCellMusicType.h"
#include "RE/I/InteriorData.h"
#include "RE/T/TESClimate.h"
#include "RE/T/TESFile.h"
#include "RE/T/TESForm.h"
#include "RE/T/TESImageSpace.h"
#include "RE/T/TESObjectCELL.h"
#include "RE/T/TESRegion.h"
#include "RE/T/TESRegionList.h"
#include "RE/T/TESWorldSpace.h"

#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

namespace {
std::string Hex(std::uint32_t value)
{
  std::ostringstream ss;
  ss << "0x" << std::uppercase << std::hex << value;
  return ss.str();
}

std::string Float(float value)
{
  std::ostringstream ss;
  ss << std::fixed << std::setprecision(2) << value;
  return ss.str();
}

std::string Color(const RE::Color& value)
{
  std::ostringstream ss;
  ss << "#";
  ss << std::uppercase << std::hex << std::setfill('0');
  ss << std::setw(2) << static_cast<int>(value.red);
  ss << std::setw(2) << static_cast<int>(value.green);
  ss << std::setw(2) << static_cast<int>(value.blue);
  return ss.str();
}

std::string FormSummary(RE::TESForm* form)
{
  if (!form) {
    return {};
  }

  std::ostringstream ss;
  ss << Hex(form->GetFormID());

  const auto editorId = form->GetFormEditorID();
  if (editorId && editorId[0] != '\0') {
    ss << " " << editorId;
  }

  return ss.str();
}

Napi::Value NullableString(Napi::Env env, const std::string& value)
{
  if (value.empty()) {
    return env.Null();
  }

  return Napi::String::New(env, value);
}

void SetNullableString(Napi::Object& obj, const char* key,
                       const std::string& value)
{
  obj.Set(key, NullableString(obj.Env(), value));
}

std::string FileName(RE::TESForm* form)
{
  if (!form) {
    return {};
  }

  auto file = form->GetDescriptionOwnerFile();
  if (!file) {
    file = form->GetFile();
  }
  if (!file) {
    return {};
  }

  return std::string(file->GetFilename());
}

std::string InteriorDataSummary(const RE::INTERIOR_DATA* data)
{
  if (!data) {
    return {};
  }

  std::ostringstream ss;
  ss << "ambient=" << Color(data->ambient);
  ss << " directional=" << Color(data->directional);
  ss << " fogNearColor=" << Color(data->fogColorNear);
  ss << " fogFarColor=" << Color(data->fogColorFar);
  ss << " fogNear=" << Float(data->fogNear);
  ss << " fogFar=" << Float(data->fogFar);
  ss << " fogPower=" << Float(data->fogPower);
  ss << " fogClamp=" << Float(data->fogClamp);
  ss << " dirFade=" << Float(data->directionalFade);
  ss << " clip=" << Float(data->clipDist);
  ss << " lightFade=" << Float(data->lightFadeStart) << "-"
     << Float(data->lightFadeEnd);
  return ss.str();
}

std::string RegionListSummary(RE::TESRegionList* regionList)
{
  if (!regionList) {
    return {};
  }

  std::vector<std::string> regions;
  for (auto region : *regionList) {
    auto summary = FormSummary(region);
    if (!summary.empty()) {
      regions.push_back(summary);
    }
  }

  std::ostringstream ss;
  for (size_t i = 0; i < regions.size(); ++i) {
    if (i != 0) {
      ss << ", ";
    }
    ss << regions[i];
  }
  return ss.str();
}

bool HasFlag(std::uint32_t flags, RE::INTERIOR_DATA::Inherit flag)
{
  return (flags & static_cast<std::uint32_t>(flag)) != 0;
}

std::string CompositeLightingSource(std::uint32_t flags, bool hasTemplate,
                                    std::uint32_t mask)
{
  if (!hasTemplate) {
    return "cell";
  }

  const auto inherited = flags & mask;
  if (inherited == 0) {
    return "cell";
  }
  if (inherited == mask) {
    return "ltmp";
  }
  return "cell+ltmp";
}

Napi::Object EffectiveSources(Napi::Env env, const RE::INTERIOR_DATA* lighting,
                              RE::BGSLightingTemplate* lightingTemplate,
                              RE::TESImageSpace* imageSpace,
                              RE::TESClimate* climate,
                              RE::BGSMusicType* cellMusic,
                              RE::BGSMusicType* worldMusic,
                              bool hasCellWater,
                              RE::TESWaterForm* worldWater)
{
  auto result = Napi::Object::New(env);
  const auto hasTemplate = lightingTemplate != nullptr;
  const auto flags =
    lighting ? lighting->lightingTemplateInheritanceFlags.underlying() : 0;

  if (lighting) {
    result.Set("ambient",
               hasTemplate &&
                   HasFlag(flags, RE::INTERIOR_DATA::Inherit::kAmbientColor)
                 ? "ltmp"
                 : "cell");

    const auto fogMask =
      static_cast<std::uint32_t>(RE::INTERIOR_DATA::Inherit::kFogColor) |
      static_cast<std::uint32_t>(RE::INTERIOR_DATA::Inherit::kFogNear) |
      static_cast<std::uint32_t>(RE::INTERIOR_DATA::Inherit::kFogFar) |
      static_cast<std::uint32_t>(RE::INTERIOR_DATA::Inherit::kClipDistance) |
      static_cast<std::uint32_t>(RE::INTERIOR_DATA::Inherit::kFogPower) |
      static_cast<std::uint32_t>(RE::INTERIOR_DATA::Inherit::kFogMax);
    result.Set("fog", CompositeLightingSource(flags, hasTemplate, fogMask));

    const auto directionalMask =
      static_cast<std::uint32_t>(
        RE::INTERIOR_DATA::Inherit::kDirectionalColor) |
      static_cast<std::uint32_t>(
        RE::INTERIOR_DATA::Inherit::kDirectionalRotation) |
      static_cast<std::uint32_t>(
        RE::INTERIOR_DATA::Inherit::kDirectionalFade);
    result.Set("directional",
               CompositeLightingSource(flags, hasTemplate, directionalMask));
  } else {
    result.Set("ambient", env.Null());
    result.Set("fog", env.Null());
    result.Set("directional", env.Null());
  }

  result.Set("imageSpace", imageSpace ? Napi::String::New(env, "cell")
                                      : env.Null());
  result.Set("climate", climate ? Napi::String::New(env, "worldspace")
                                : env.Null());

  if (cellMusic) {
    result.Set("music", "cell");
  } else if (worldMusic) {
    result.Set("music", "worldspace");
  } else {
    result.Set("music", env.Null());
  }

  if (hasCellWater) {
    result.Set("water", "cell");
  } else if (worldWater) {
    result.Set("water", "worldspace");
  } else {
    result.Set("water", env.Null());
  }

  return result;
}
}

Napi::Value CellDebugApi::GetCellEnvironmentDebugData(
  const Napi::CallbackInfo& info)
{
  auto cellFormId = NapiHelper::ExtractUInt32(info[0], "cellFormId");
  auto cell = RE::TESForm::LookupByID<RE::TESObjectCELL>(cellFormId);
  if (!cell) {
    return info.Env().Null();
  }

  auto& runtime = cell->GetRuntimeData();
  auto lighting = cell->GetLighting();
  auto lightingTemplate = runtime.lightingTemplate;
  auto worldSpace = runtime.worldSpace;
  auto imageSpaceExtra = cell->extraList.GetByType<RE::ExtraCellImageSpace>();
  auto musicExtra = cell->extraList.GetByType<RE::ExtraCellMusicType>();
  auto imageSpace = imageSpaceExtra ? imageSpaceExtra->imageSpace : nullptr;
  auto cellMusic = musicExtra ? musicExtra->type : nullptr;
  auto climate = worldSpace ? worldSpace->climate : nullptr;
  auto worldMusic = worldSpace ? worldSpace->musicType : nullptr;
  auto worldWater = worldSpace ? worldSpace->worldWater : nullptr;
  auto hasCellWater =
    cell->cellFlags.all(RE::TESObjectCELL::Flag::kHasWater);

  auto result = Napi::Object::New(info.Env());
  SetNullableString(result, "winningCellPlugin", FileName(cell));
  SetNullableString(result, "xcll", InteriorDataSummary(lighting));
  SetNullableString(result, "ltmp", FormSummary(lightingTemplate));
  SetNullableString(
    result, "ltmpInheritanceFlags",
    lighting ? Hex(lighting->lightingTemplateInheritanceFlags.underlying())
             : "");
  SetNullableString(result, "imgs", FormSummary(imageSpace));
  SetNullableString(result, "clmt", FormSummary(climate));
  SetNullableString(result, "xclr",
                    RegionListSummary(cell->GetRegionList(false)));
  SetNullableString(result, "xclm", FormSummary(cellMusic));
  SetNullableString(result, "xclw",
                    hasCellWater ? Float(runtime.waterHeight) : "");
  result.Set("effectiveSources",
             EffectiveSources(info.Env(), lighting, lightingTemplate,
                              imageSpace, climate, cellMusic, worldMusic,
                              hasCellWater, worldWater));

  return result;
}
