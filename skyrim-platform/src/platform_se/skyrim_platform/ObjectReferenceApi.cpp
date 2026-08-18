#include "ObjectReferenceApi.h"

#include "NullPointerException.h"
#include "RE/T/TESObjectLIGH.h"

namespace {
RE::TESForm* GetArgForm(const Napi::Value& arg)
{
  auto formId = NapiHelper::ExtractUInt32(arg, "formId");
  return RE::TESForm::LookupByID(formId);
}

RE::TESObjectREFR* GetArgObjectReference(const Napi::Value& arg)
{
  auto formId = NapiHelper::ExtractUInt32(arg, "refrFormId");
  auto refr = RE::TESForm::LookupByID<RE::TESObjectREFR>(formId);

  if (!refr) {
    throw NullPointerException("refr");
  }

  return refr;
}

bool IsItemFormType(RE::FormType formType) noexcept
{
  return formType == RE::FormType::Ammo || formType == RE::FormType::Armor ||
    formType == RE::FormType::Book || formType == RE::FormType::Ingredient ||
    formType == RE::FormType::AlchemyItem ||
    formType == RE::FormType::Scroll || formType == RE::FormType::SoulGem ||
    formType == RE::FormType::Weapon || formType == RE::FormType::Misc ||
    formType == RE::FormType::Light;
}
}

Napi::Value ObjectReferenceApi::IsPickupableItem(
  const Napi::CallbackInfo& info)
{
  auto form = GetArgForm(info[0]);
  const auto formType = form ? form->formType.get() : RE::FormType::None;
  if (!form || !IsItemFormType(formType)) {
    return Napi::Boolean::New(info.Env(), false);
  }

  if (formType == RE::FormType::Light) {
    auto light = form->As<RE::TESObjectLIGH>();
    return Napi::Boolean::New(info.Env(), light && light->CanBeCarried());
  }

  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value ObjectReferenceApi::SetCollision(const Napi::CallbackInfo& info)
{
  auto refr = GetArgObjectReference(info[0]);
  refr->SetCollision(NapiHelper::ExtractBoolean(info[1], "collision"));
  return info.Env().Undefined();
}
