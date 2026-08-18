#include "FridaHooks.h"
#include "EventsApi.h"
#include "FridaHookHandler.h"
#include "FridaHooksUtils.h"
#include "Override.h"
#include "PapyrusTESModPlatform.h"
#include "StringHolder.h"

#include <cstring>
#include <filesystem>
#include <fstream>
#include <fmt/format.h>
#include <vector>

/**
 * Send Event hook
 */

namespace {
bool StartsWithIgnoreCase(const char* s, const std::string& prefix)
{
  if (!s) {
    return false;
  }
  const auto prefixLength = prefix.size();
  return strlen(s) >= prefixLength &&
    _strnicmp(s, prefix.c_str(), prefixLength) == 0;
}

bool EqualsIgnoreCase(const char* lhs, const std::string& rhs)
{
  return lhs && !stricmp(lhs, rhs.c_str());
}

struct PapyrusEventAllowConfigSection
{
  std::vector<std::string> startsWithAllow;
  std::vector<std::string> allowExplicit;
};

struct PapyrusEventAllowConfig
{
  PapyrusEventAllowConfigSection events;
  PapyrusEventAllowConfigSection scripts;
};

PapyrusEventAllowConfig GetDefaultPapyrusEventAllowConfig()
{
  PapyrusEventAllowConfig config;
  config.scripts.startsWithAllow = { "SKI_" };
  config.scripts.allowExplicit = { "defaultDisableHavokOnLoad" };
  return config;
}

PapyrusEventAllowConfig g_papyrusEventAllowConfig =
  GetDefaultPapyrusEventAllowConfig();

void AppendStringArray(const nlohmann::json& root, const char* key,
                       std::vector<std::string>& result)
{
  if (!root.contains(key)) {
    return;
  }

  if (!root[key].is_array()) {
    logger::warn(
      "Papyrus event allow config key '{}' must be an array of strings", key);
    return;
  }

  for (const auto& value : root[key]) {
    if (!value.is_string()) {
      logger::warn(
        "Papyrus event allow config key '{}' contains a non-string value", key);
      continue;
    }
    result.push_back(value.get<std::string>());
  }
}

void AppendConfigSection(const nlohmann::json& root, const char* key,
                         PapyrusEventAllowConfigSection& section)
{
  if (!root.contains(key)) {
    return;
  }

  if (!root[key].is_object()) {
    logger::warn("Papyrus event allow config key '{}' must be an object", key);
    return;
  }

  AppendStringArray(root[key], "StartsWith_Allow", section.startsWithAllow);
  AppendStringArray(root[key], "AllowExplicit", section.allowExplicit);
}

PapyrusEventAllowConfig ParsePapyrusEventAllowConfig(
  const nlohmann::json& root)
{
  auto config = GetDefaultPapyrusEventAllowConfig();
  AppendConfigSection(root, "Events", config.events);
  AppendConfigSection(root, "Scripts", config.scripts);
  return config;
}

PapyrusEventAllowConfig LoadPapyrusEventAllowConfig()
{
  static constexpr auto configPath =
    "Data\\Platform\\Plugins\\skymp5-client-AllowPapyrusEvents.json";

  std::error_code ec;
  if (!std::filesystem::exists(configPath, ec)) {
    logger::warn("Papyrus event allow config not found: {}", configPath);
    return GetDefaultPapyrusEventAllowConfig();
  }

  try {
    std::ifstream file(configPath);
    if (!file.is_open()) {
      logger::warn("Failed to open Papyrus event allow config: {}",
                   configPath);
      return GetDefaultPapyrusEventAllowConfig();
    }

    nlohmann::json root;
    file >> root;
    logger::info("Loaded Papyrus event allow config: {}", configPath);
    return ParsePapyrusEventAllowConfig(root);
  } catch (const std::exception& e) {
    logger::error("Failed to load Papyrus event allow config '{}': {}",
                  configPath, e.what());
  }

  return GetDefaultPapyrusEventAllowConfig();
}

void InitializePapyrusEventAllowConfig()
{
  g_papyrusEventAllowConfig = LoadPapyrusEventAllowConfig();
}

const PapyrusEventAllowConfig& GetPapyrusEventAllowConfig()
{
  return g_papyrusEventAllowConfig;
}

bool AnyEqualsIgnoreCase(const char* value,
                         const std::vector<std::string>& candidates)
{
  for (const auto& candidate : candidates) {
    if (EqualsIgnoreCase(value, candidate)) {
      return true;
    }
  }
  return false;
}

bool AnyStartsWithIgnoreCase(const char* value,
                             const std::vector<std::string>& prefixes)
{
  for (const auto& prefix : prefixes) {
    if (StartsWithIgnoreCase(value, prefix)) {
      return true;
    }
  }
  return false;
}

bool ShouldAllowPapyrusEventName(const char* eventName,
                                 const PapyrusEventAllowConfig& config)
{
  return AnyStartsWithIgnoreCase(eventName, config.events.startsWithAllow) ||
    AnyEqualsIgnoreCase(eventName, config.events.allowExplicit);
}

bool ShouldAllowPapyrusScriptName(const char* scriptName,
                                  const PapyrusEventAllowConfig& config)
{
  return AnyStartsWithIgnoreCase(scriptName, config.scripts.startsWithAllow) ||
    AnyEqualsIgnoreCase(scriptName, config.scripts.allowExplicit);
}

template <class ScriptList>
bool ShouldAllowPapyrusEvent(const char* eventName, const ScriptList& scripts,
                             const PapyrusEventAllowConfig& config)
{
  if (ShouldAllowPapyrusEventName(eventName, config)) {
    return true;
  }

  for (size_t i = 0; i < scripts.size(); i++) {
    auto script = scripts[i].get();
    auto info = script->GetTypeInfo();
    auto name = info->GetName();

    if (ShouldAllowPapyrusScriptName(name, config)) {
      return true;
    }
  }

  return false;
}
}

// (VMHandle handle, const BSFixedString& eventName, IFunctionArguments* args)
void OnSendEventEnter(GumInvocationContext* ic)
{
  if (Override::IsOverriden()) {
    return;
  }
  auto handle = (RE::VMHandle)gum_invocation_context_get_nth_argument(ic, 1);
  auto eventName = (char**)gum_invocation_context_get_nth_argument(ic, 2);

  auto vm = VM::GetSingleton();

  uint32_t selfId = 0;

  auto policy = vm->GetObjectHandlePolicy();
  if (policy) {
    if (auto actor =
          policy->GetObjectForHandle(RE::FormType::ActorCharacter, handle)) {
      selfId = actor->GetFormID();
    }
    if (auto refr =
          policy->GetObjectForHandle(RE::FormType::Reference, handle)) {
      selfId = refr->GetFormID();
    }
  }

  auto eventNameStr = std::string(*eventName);
  EventsApi::SendPapyrusEventEnter(selfId, eventNameStr);

  auto blockEvents = TESModPlatform::GetPapyrusEventsBlocked();
  if (blockEvents && strcmp(*eventName, "OnUpdate") != 0 && vm) {
    vm->attachedScriptsLock.Lock();
    auto it = vm->attachedScripts.find(handle);

    if (it != vm->attachedScripts.end()) {
      auto& scripts = it->second;
      const auto& config = GetPapyrusEventAllowConfig();
      if (ShouldAllowPapyrusEvent(*eventName, scripts, config)) {
        // Maybe worth unblocking events only for this script, not for all
        blockEvents = false;
      }
    }

    vm->attachedScriptsLock.Unlock();
  }

  if (blockEvents) {
    static const auto fsEmpty = new FixedString("");
    gum_invocation_context_replace_nth_argument(ic, 2, fsEmpty);
  }
}

void OnSendEventLeave(GumInvocationContext* ic)
{
  if (Override::IsOverriden()) {
    return;
  }
  EventsApi::SendPapyrusEventLeave();
}

void InstallSendEventHook()
{
  InitializePapyrusEventAllowConfig();

  Frida::HookHandler::GetSingleton()->Install(
    Frida::HookID::SEND_EVENT, Offsets::Hooks::SendEvent.address(),
    std::make_shared<Frida::Hook>(OnSendEventEnter, OnSendEventLeave));
}

/**
 *  Draw Sheathe Weapon PC hook
 */
void OnDrawSheatheWeaponPcEnter(GumInvocationContext* ic)
{
  auto refr =
    ic->cpu_context->rcx ? (RE::Actor*)(ic->cpu_context->rcx) : nullptr;
  uint32_t formId = refr ? refr->formID : 0;

  union
  {
    size_t draw;
    uint8_t byte[8];
  };

  draw = (size_t)gum_invocation_context_get_nth_argument(ic, 1);

  auto falseValue = gpointer(*byte ? draw - 1 : draw);
  auto trueValue = gpointer(*byte ? draw : draw + 1);

  auto mode = TESModPlatform::GetWeapDrawnMode(formId);
  if (mode == TESModPlatform::WEAP_DRAWN_MODE_ALWAYS_TRUE) {
    gum_invocation_context_replace_nth_argument(ic, 1, trueValue);
  } else if (mode == TESModPlatform::WEAP_DRAWN_MODE_ALWAYS_FALSE) {
    gum_invocation_context_replace_nth_argument(ic, 1, falseValue);
  }
}

void InstallDrawSheatheWeaponPcHook()
{
  Frida::HookHandler::GetSingleton()->Install(
    Frida::HookID::DRAW_SHEATHE_WEAPON_PC,
    Offsets::Hooks::DrawSheatheWeaponPC.address(),
    std::make_shared<Frida::Hook>(OnDrawSheatheWeaponPcEnter, nullptr));
}

/**
 * Draw Sheathe Weapon Actor hook
 */
void OnDrawSheatheWeaponActorEnter(GumInvocationContext* ic)
{
  auto refr =
    ic->cpu_context->rcx ? (RE::Actor*)(ic->cpu_context->rcx) : nullptr;
  uint32_t formId = refr ? refr->formID : 0;

  auto draw = (uint32_t*)gum_invocation_context_get_nth_argument(ic, 1);

  auto mode = TESModPlatform::GetWeapDrawnMode(formId);
  if (mode == TESModPlatform::WEAP_DRAWN_MODE_ALWAYS_TRUE) {
    gum_invocation_context_replace_nth_argument(ic, 1, gpointer(1));
  } else if (mode == TESModPlatform::WEAP_DRAWN_MODE_ALWAYS_FALSE) {
    gum_invocation_context_replace_nth_argument(ic, 1, gpointer(0));
  }
}

void InstallDrawSheatheWeaponActorHook()
{
  Frida::HookHandler::GetSingleton()->Install(
    Frida::HookID::DRAW_SHEATHE_WEAPON_ACTOR,
    Offsets::Hooks::DrawSheatheWeaponActor.address(),
    std::make_shared<Frida::Hook>(OnDrawSheatheWeaponActorEnter, nullptr));
}

/**
 * Send Animation Event hook
 */
void OnSendAnimationEventEnter(GumInvocationContext* ic)
{
  if (Override::IsOverriden()) {
    return;
  }
  auto refr = ic->cpu_context->rcx
    ? (RE::TESObjectREFR*)(ic->cpu_context->rcx - 0x38)
    : nullptr;
  uint32_t formId = refr ? refr->formID : 0;

  constexpr int argIdx = 1;
  auto animEventName =
    (char**)gum_invocation_context_get_nth_argument(ic, argIdx);

  if (!refr || !animEventName)
    return;

  std::string str = *animEventName;
  if (str == "") {
    return;
  }
  EventsApi::SendAnimationEventEnter(formId, str);
  if (str != *animEventName) {
    auto fs =
      const_cast<RE::BSFixedString*>(&StringHolder::ThreadSingleton()[str]);
    auto newAnimEventName = reinterpret_cast<char**>(fs);
    gum_invocation_context_replace_nth_argument(ic, argIdx, newAnimEventName);
  }
}

void OnSendAnimationEventLeave(GumInvocationContext* ic)
{
  if (Override::IsOverriden()) {
    return;
  }
  bool res = !!gum_invocation_context_get_return_value(ic);
  EventsApi::SendAnimationEventLeave(res);
}

void InstallSendAnimationEventHook()
{
  Frida::HookHandler::GetSingleton()->Install(
    Frida::HookID::HOOK_SEND_ANIMATION_EVENT,
    Offsets::Hooks::SendAnimation.address(),
    std::make_shared<Frida::Hook>(OnSendAnimationEventEnter,
                                  OnSendAnimationEventLeave));
}

/**
 * Queue Ninode Update hook
 */
thread_local uint32_t g_queueNiNodeActorId = 0;

void OnQueueNinodeUpdateEnter(GumInvocationContext* ic)
{
  auto refr = ic->cpu_context->rcx ? (RE::TESObjectREFR*)(ic->cpu_context->rcx)
                                   : nullptr;

  uint32_t id = refr ? refr->formID : 0;

  g_queueNiNodeActorId = id;
}

void InstallQueueNinodeUpdateHook()
{
  Frida::HookHandler::GetSingleton()->Install(
    Frida::HookID::QUEUE_NINODE_UPDATE,
    Offsets::Hooks::QueueNinodeUpdate.address(),
    std::make_shared<Frida::Hook>(OnQueueNinodeUpdateEnter, nullptr));
}

/**
 * Apply Masks To Render Targets hook
 */
void OnApplyMasksToRenderTargetsEnter(GumInvocationContext* ic)
{
  if (g_queueNiNodeActorId > 0) {
    auto tints = TESModPlatform::GetTintsFor(g_queueNiNodeActorId);
    if (tints) {
      gum_invocation_context_replace_nth_argument(ic, 0, tints.get());
    }
  }

  g_queueNiNodeActorId = 0;
}

void InstallApplyMasksToRenderTargetsHook()
{
  Frida::HookHandler::GetSingleton()->Install(
    Frida::HookID::APPLY_MASKS_TO_RENDER_TARGET,
    Offsets::Hooks::ApplyMasksToRenderTargets.address(),
    std::make_shared<Frida::Hook>(OnApplyMasksToRenderTargetsEnter, nullptr));
}

/**
 * Render Cursor Menu hook
 */
bool g_allowHideCursorMenu = true;

void OnRenderCursorMenuEnter(GumInvocationContext* ic)
{
  auto menu = FridaHooksUtils::GetMenuByName(RE::CursorMenu::MENU_NAME);
  auto this_ = reinterpret_cast<int64_t*>(ic->cpu_context->rcx);
  if (!this_ || !g_allowHideCursorMenu || this_ != menu) {
    return;
  }

  auto& visibleFlag = CEFUtils::DX11RenderHandler::Visible();
  auto& focusFlag = CEFUtils::DInputHook::ChromeFocus();
  if (visibleFlag && focusFlag) {
    FridaHooksUtils::SetMenuNumberVariable(RE::CursorMenu::MENU_NAME,
                                           "_root.mc_Cursor._alpha", 0);
  } else {
    FridaHooksUtils::SetMenuNumberVariable(RE::CursorMenu::MENU_NAME,
                                           "_root.mc_Cursor._alpha", 100);
  }

  auto strings = {
    R"(_root.MenuHolder.Menu_mc.MainListHolder.List_mc._alpha)"
  };

  if (visibleFlag && focusFlag) {
    for (auto string : strings) {
      FridaHooksUtils::SetMenuNumberVariable(RE::MainMenu::MENU_NAME, string,
                                             0);
    }
  } else {
    for (auto string : strings) {
      FridaHooksUtils::SetMenuNumberVariable(RE::MainMenu::MENU_NAME, string,
                                             100);
    }
  }
}

void InstallRenderCursorMenuHook()
{
  Frida::HookHandler::GetSingleton()->Install(
    Frida::HookID::RENDER_CURSOR_MENU,
    Offsets::Hooks::RenderCursorMenu.address(),
    std::make_shared<Frida::Hook>(OnRenderCursorMenuEnter, nullptr));
}

// void OnFunctionRegistered(RE::BSScript::NativeFunction* func)
// {
//         // GetNativeFunctionAddr::Result result =
//         GetNativeFunctionAddr::Run(*func);

//         // auto offset = ((uint64_t)func->_callback) -
//         ((uint64_t)REL::Module::get().base());

//         const char *className = func->GetClassName()->data();
//         const char *name = func->GetName()->data();

//         // uint64_t returnType = ~0;
//         // returnType = (uint64_t)func->GetReturnType(&returnType);
//         // auto t = GetCppTypeName(returnType);

//         // std::string params;
//         // uint64_t numParams = func->GetNumParams();
//         // for (uint64_t i = 0; i < numParams; i++) {
//         //     RE::BSFixedString a_nameOut;
//         //     uint64_t a_typeOut;
//         //     a_typeOut = (uint64_t)func->GetParam(i, &a_nameOut,
//         &a_typeOut);

//         //     params += GetCppTypeName(a_typeOut);
//         //     params += ' ';
//         //     params += a_nameOut.data();
//         //     if (i != numParams - 1) {
//         //         params += ", ";
//         //     }
//         // }

//         // file << std::hex << "static REL::Relocation<" << t << " (*)(" <<
//         params << ")> " << className << '_' << name << "{ REL::Offset(0x" <<
//         offset << ") };" << std::endl;
// }

void InstallNativeFunctionCtorHook() noexcept
{
  // using func_t =
  // std::add_pointer_t<RE::BSScript::NativeFunction*(RE::BSScript::NativeFunction*,
  // const char*, const char*, bool, std::uint32_t)>; REL::Relocation<func_t>
  // nativeFunctionCtor{ REL::Offset(0x03076DE8) };

  // struct State
  // {
  //     uint64_t thisarg = 0;
  // };
  // std::shared_ptr<State> state(new State);
  // Frida::Hook            hook3{
  //     [state](GumInvocationContext* context) {
  //         auto self      =
  //         (RE::BSScript::NativeFunction*)context->cpu_context->rcx;
  //         state->thisarg = (uint64_t)self;
  //     },
  //     [state](GumInvocationContext* context) {
  //         auto self = (RE::BSScript::NativeFunction*)state->thisarg;
  //         OnFunctionRegistered(self);
  //     }
  // };

  // Frida::HookHandler::GetSingleton()->Install(Frida::HookID::NATIVE_FUNCTION_CTOR,
  // nativeFunctionCtor.address(), std::make_shared<Frida::Hook>(hook3));
}

void Frida::InstallHooks()
{
  InstallSendEventHook();
  InstallDrawSheatheWeaponPcHook();
  InstallDrawSheatheWeaponActorHook();
  InstallSendAnimationEventHook();
  InstallQueueNinodeUpdateHook();
  InstallRenderCursorMenuHook();
#ifdef ENABLE_SKYRIM_AE
  InstallApplyMasksToRenderTargetsHook();
#endif
  InstallNativeFunctionCtorHook();

  logger::info("Frida hooks installed.");
}
