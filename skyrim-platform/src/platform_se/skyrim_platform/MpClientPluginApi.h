#pragma once
#include "NapiHelper.h"

namespace MpClientPluginApi {
Napi::Value GetVersion(const Napi::CallbackInfo& info);
Napi::Value CreateClient(const Napi::CallbackInfo& info);
Napi::Value DestroyClient(const Napi::CallbackInfo& info);
Napi::Value IsConnected(const Napi::CallbackInfo& info);
Napi::Value Tick(const Napi::CallbackInfo& info);
Napi::Value Send(const Napi::CallbackInfo& info);
Napi::Value SendRaw(const Napi::CallbackInfo& args);

// Voice chat (optional — only present when MpClientPlugin has voice support)
Napi::Value InitVoiceChat(const Napi::CallbackInfo& info);
Napi::Value ShutdownVoiceChat(const Napi::CallbackInfo& info);
Napi::Value IsVoiceChatInitialized(const Napi::CallbackInfo& info);
Napi::Value StartTalking(const Napi::CallbackInfo& info);
Napi::Value StopTalking(const Napi::CallbackInfo& info);
Napi::Value IsTalking(const Napi::CallbackInfo& info);
Napi::Value SetVoiceMode(const Napi::CallbackInfo& info);
Napi::Value SetVoiceInputGain(const Napi::CallbackInfo& info);
Napi::Value SetVoiceOutputVolume(const Napi::CallbackInfo& info);
Napi::Value TickVoiceChat(const Napi::CallbackInfo& info);
Napi::Value NeedsVoiceReconnect(const Napi::CallbackInfo& info);
Napi::Value SetVoiceParticipantPosition(const Napi::CallbackInfo& info);
Napi::Value SetVoiceListenerPosition(const Napi::CallbackInfo& info);
Napi::Value SetVoiceRange(const Napi::CallbackInfo& info);
Napi::Value SetVoiceNoiseGateEnabled(const Napi::CallbackInfo& info);
Napi::Value SetVoiceNoiseGateThreshold(const Napi::CallbackInfo& info);
Napi::Value SetVoiceNormalizationEnabled(const Napi::CallbackInfo& info);
Napi::Value SetVoiceNormalizationTarget(const Napi::CallbackInfo& info);
Napi::Value GetVoiceRemoteParticipants(const Napi::CallbackInfo& info);

void RegisterVoiceChatIfAvailable(Napi::Env env, Napi::Object& mpClientPlugin);

inline void Register(Napi::Env env, Napi::Object& exports)
{
  auto mpClientPlugin = Napi::Object::New(env);
  mpClientPlugin.Set(
    "getVersion",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(GetVersion)));
  mpClientPlugin.Set(
    "createClient",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(CreateClient)));
  mpClientPlugin.Set(
    "destroyClient",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(DestroyClient)));
  mpClientPlugin.Set(
    "isConnected",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(IsConnected)));
  mpClientPlugin.Set(
    "tick", Napi::Function::New(env, NapiHelper::WrapCppExceptions(Tick)));
  mpClientPlugin.Set(
    "send", Napi::Function::New(env, NapiHelper::WrapCppExceptions(Send)));
  mpClientPlugin.Set(
    "sendRaw",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SendRaw)));

  // Voice chat functions — only register if MpClientPlugin exports them
  RegisterVoiceChatIfAvailable(env, mpClientPlugin);

  exports.Set("mpClientPlugin", mpClientPlugin);
}
}
