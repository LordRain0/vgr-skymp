#include "MpClientPluginApi.h"

namespace {
const char* GetPacketTypeName(int32_t type)
{
  switch (type) {
    case 0:
      return "message";
    case 1:
      return "disconnect";
    case 2:
      return "connectionAccepted";
    case 3:
      return "connectionFailed";
    case 4:
      return "connectionDenied";
    default:
      return "";
  }
}

class MpClientPlugin
{
public:
  MpClientPlugin()
  {
    // Add the game root directory to the DLL search path so that
    // MpClientPlugin.dll's dependencies (e.g. livekit.dll) can be found
    // even when loaded from a subdirectory like Data/SKSE/Plugins/
    SetDllDirectoryA(".");

    hModule = LoadLibraryA("Data/SKSE/Plugins/MpClientPlugin.dll");

    // Restore default DLL search order
    SetDllDirectoryA(nullptr);

    if (!hModule) {
      throw std::runtime_error("Unable to load MpClientPlugin, error code " +
                               std::to_string(GetLastError()));
    }
  }

  void* GetFunction(const char* funcName)
  {
    auto addr = GetProcAddress(hModule, funcName);
    if (!addr) {
      throw std::runtime_error(
        "Unable to find function with name '" + std::string(funcName) +
        "' in MpClientPlugin, error code " + std::to_string(GetLastError()));
    }
    return addr;
  }

  void* TryGetFunction(const char* funcName)
  {
    return GetProcAddress(hModule, funcName);
  }

  HMODULE hModule = nullptr;
};

MpClientPlugin* GetMpClientPlugin()
{
  static MpClientPlugin instance;
  return &instance;
}
}

Napi::Value MpClientPluginApi::GetVersion(const Napi::CallbackInfo& info)
{
  typedef const char* (*GetVersion)();
  auto f = (GetVersion)GetMpClientPlugin()->GetFunction("MpCommonGetVersion");
  return Napi::String::New(info.Env(), f());
}

Napi::Value MpClientPluginApi::CreateClient(const Napi::CallbackInfo& info)
{
  auto hostName = NapiHelper::ExtractString(info[0], "hostName");
  auto port = NapiHelper::ExtractInt32(info[1], "port");

  if (port < 0 || port > 65535) {
    throw std::runtime_error(std::to_string(port) + " is not a valid port");
  }

  typedef void (*CreateClient)(const char* hostName, uint16_t port);
  auto f = (CreateClient)GetMpClientPlugin()->GetFunction("CreateClient");
  f(hostName.data(), static_cast<uint16_t>(port));
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::DestroyClient(const Napi::CallbackInfo& info)
{
  typedef void (*DestroyClient)();
  auto f = (DestroyClient)GetMpClientPlugin()->GetFunction("DestroyClient");
  f();
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::IsConnected(const Napi::CallbackInfo& info)
{
  typedef bool (*IsConnected)();
  auto f = (IsConnected)GetMpClientPlugin()->GetFunction("IsConnected");
  return Napi::Boolean::New(info.Env(), f());
}

Napi::Value MpClientPluginApi::Tick(const Napi::CallbackInfo& info)
{
  auto onPacket = NapiHelper::ExtractFunction(info[0], "onPacket");

  typedef void (*OnPacket)(int32_t type, const char* rawContent, size_t length,
                           const char* error, void* state);
  typedef void (*Tick)(OnPacket onPacket, void* state);

  auto f = (Tick)GetMpClientPlugin()->GetFunction("Tick");
  f(
    [](int32_t type, const char* rawContent, size_t length, const char* error,
       void* state) {
      auto onPacket = reinterpret_cast<Napi::Function*>(state);
      auto env = onPacket->Env();

      Napi::Value rawContentArrayBuffer;

      if (length > 0) {
        rawContentArrayBuffer = Napi::ArrayBuffer::New(env, length);
        memcpy(rawContentArrayBuffer.As<Napi::ArrayBuffer>().Data(),
               rawContent, length);
      } else {
        rawContentArrayBuffer = env.Null();
      }
      onPacket->Call({ Napi::String::New(env, GetPacketTypeName(type)),
                       rawContentArrayBuffer, Napi::String::New(env, error) });
    },
    &onPacket);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::Send(const Napi::CallbackInfo& info)
{
  typedef void (*Send)(const char* jsonContent, bool reliable);

  auto jsonContent = NapiHelper::ExtractString(info[0], "jsonContent");
  auto reliable = NapiHelper::ExtractBoolean(info[1], "reliable");

  auto f = (Send)GetMpClientPlugin()->GetFunction("Send");
  f(jsonContent.data(), reliable);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SendRaw(const Napi::CallbackInfo& info)
{
  typedef void (*SendRaw)(const void* data, size_t size, bool reliable);

  auto rawContent = NapiHelper::ExtractArrayBuffer(info[0], "rawContent");

  auto data = rawContent.Data();
  auto dataLength = rawContent.ByteLength();

  auto size = NapiHelper::ExtractInt32(info[1], "size");

  if (dataLength != size) {
    throw std::runtime_error("Sizes don't match");
  }

  auto reliable = NapiHelper::ExtractBoolean(info[2], "reliable");

  auto f = (SendRaw)GetMpClientPlugin()->GetFunction("SendRaw");
  f(data, dataLength, reliable);
  return info.Env().Undefined();
}

// Voice chat wrappers (optional — only available when MpClientPlugin
// is built with SKYMP_VOICE_CHAT_ENABLED)

Napi::Value MpClientPluginApi::InitVoiceChat(const Napi::CallbackInfo& info)
{
  auto url = NapiHelper::ExtractString(info[0], "livekitUrl");
  auto token = NapiHelper::ExtractString(info[1], "token");
  auto sampleRate = NapiHelper::ExtractInt32(info[2], "sampleRate");
  auto numChannels = NapiHelper::ExtractInt32(info[3], "numChannels");

  typedef bool (*Fn)(const char*, const char*, int, int);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("InitVoiceChat");
  return Napi::Boolean::New(info.Env(), f(url.data(), token.data(), sampleRate, numChannels));
}

Napi::Value MpClientPluginApi::ShutdownVoiceChat(const Napi::CallbackInfo& info)
{
  typedef void (*Fn)();
  auto f = (Fn)GetMpClientPlugin()->GetFunction("ShutdownVoiceChat");
  f();
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::IsVoiceChatInitialized(const Napi::CallbackInfo& info)
{
  typedef bool (*Fn)();
  auto f = (Fn)GetMpClientPlugin()->GetFunction("IsVoiceChatInitialized");
  return Napi::Boolean::New(info.Env(), f());
}

Napi::Value MpClientPluginApi::StartTalking(const Napi::CallbackInfo& info)
{
  typedef void (*Fn)();
  auto f = (Fn)GetMpClientPlugin()->GetFunction("StartTalking");
  f();
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::StopTalking(const Napi::CallbackInfo& info)
{
  typedef void (*Fn)();
  auto f = (Fn)GetMpClientPlugin()->GetFunction("StopTalking");
  f();
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::IsTalking(const Napi::CallbackInfo& info)
{
  typedef bool (*Fn)();
  auto f = (Fn)GetMpClientPlugin()->GetFunction("IsTalking");
  return Napi::Boolean::New(info.Env(), f());
}

Napi::Value MpClientPluginApi::SetVoiceMode(const Napi::CallbackInfo& info)
{
  auto mode = NapiHelper::ExtractInt32(info[0], "mode");
  typedef void (*Fn)(int32_t);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceMode");
  f(mode);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SetVoiceInputGain(const Napi::CallbackInfo& info)
{
  auto gain = NapiHelper::ExtractFloat(info[0], "gain");
  typedef void (*Fn)(float);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceInputGain");
  f(gain);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SetVoiceOutputVolume(const Napi::CallbackInfo& info)
{
  auto volume = NapiHelper::ExtractFloat(info[0], "volume");
  typedef void (*Fn)(float);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceOutputVolume");
  f(volume);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::TickVoiceChat(const Napi::CallbackInfo& info)
{
  typedef void (*Fn)();
  auto f = (Fn)GetMpClientPlugin()->GetFunction("TickVoiceChat");
  f();
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::NeedsVoiceReconnect(const Napi::CallbackInfo& info)
{
  typedef bool (*Fn)();
  auto f = (Fn)GetMpClientPlugin()->GetFunction("NeedsVoiceReconnect");
  return Napi::Boolean::New(info.Env(), f());
}

Napi::Value MpClientPluginApi::SetVoiceParticipantPosition(const Napi::CallbackInfo& info)
{
  auto identity = NapiHelper::ExtractString(info[0], "identity");
  auto x = NapiHelper::ExtractFloat(info[1], "x");
  auto y = NapiHelper::ExtractFloat(info[2], "y");
  auto z = NapiHelper::ExtractFloat(info[3], "z");
  typedef void (*Fn)(const char*, float, float, float);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceParticipantPosition");
  f(identity.data(), x, y, z);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SetVoiceListenerPosition(const Napi::CallbackInfo& info)
{
  auto x = NapiHelper::ExtractFloat(info[0], "x");
  auto y = NapiHelper::ExtractFloat(info[1], "y");
  auto z = NapiHelper::ExtractFloat(info[2], "z");
  auto dirX = NapiHelper::ExtractFloat(info[3], "dirX");
  auto dirY = NapiHelper::ExtractFloat(info[4], "dirY");
  auto dirZ = NapiHelper::ExtractFloat(info[5], "dirZ");
  typedef void (*Fn)(float, float, float, float, float, float);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceListenerPosition");
  f(x, y, z, dirX, dirY, dirZ);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SetVoiceRange(const Napi::CallbackInfo& info)
{
  auto range = NapiHelper::ExtractFloat(info[0], "range");
  typedef void (*Fn)(float);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceRange");
  f(range);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SetVoiceNoiseGateEnabled(const Napi::CallbackInfo& info)
{
  auto enabled = NapiHelper::ExtractBoolean(info[0], "enabled");
  typedef void (*Fn)(bool);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceNoiseGateEnabled");
  f(enabled);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SetVoiceNoiseGateThreshold(const Napi::CallbackInfo& info)
{
  auto threshold = NapiHelper::ExtractFloat(info[0], "threshold");
  typedef void (*Fn)(float);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceNoiseGateThreshold");
  f(threshold);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SetVoiceNormalizationEnabled(const Napi::CallbackInfo& info)
{
  auto enabled = NapiHelper::ExtractBoolean(info[0], "enabled");
  typedef void (*Fn)(bool);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceNormalizationEnabled");
  f(enabled);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::SetVoiceNormalizationTarget(const Napi::CallbackInfo& info)
{
  auto target = NapiHelper::ExtractFloat(info[0], "target");
  typedef void (*Fn)(float);
  auto f = (Fn)GetMpClientPlugin()->GetFunction("SetVoiceNormalizationTarget");
  f(target);
  return info.Env().Undefined();
}

Napi::Value MpClientPluginApi::GetVoiceRemoteParticipants(const Napi::CallbackInfo& info)
{
  typedef const char* (*Fn)();
  auto f = (Fn)GetMpClientPlugin()->GetFunction("GetVoiceRemoteParticipants");
  const char* json = f();
  return Napi::String::New(info.Env(), json);
}

void MpClientPluginApi::RegisterVoiceChatIfAvailable(
  Napi::Env env, Napi::Object& mpClientPlugin)
{
  try {
    if (!GetMpClientPlugin()->TryGetFunction("InitVoiceChat")) {
      return; // Voice chat not available in this MpClientPlugin build
    }
  } catch (...) {
    return;
  }

  mpClientPlugin.Set(
    "initVoiceChat",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(InitVoiceChat)));
  mpClientPlugin.Set(
    "shutdownVoiceChat",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(ShutdownVoiceChat)));
  mpClientPlugin.Set(
    "isVoiceChatInitialized",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(IsVoiceChatInitialized)));
  mpClientPlugin.Set(
    "startTalking",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(StartTalking)));
  mpClientPlugin.Set(
    "stopTalking",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(StopTalking)));
  mpClientPlugin.Set(
    "isTalking",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(IsTalking)));
  mpClientPlugin.Set(
    "setVoiceMode",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceMode)));
  mpClientPlugin.Set(
    "setVoiceInputGain",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceInputGain)));
  mpClientPlugin.Set(
    "setVoiceOutputVolume",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceOutputVolume)));
  mpClientPlugin.Set(
    "tickVoiceChat",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(TickVoiceChat)));
  mpClientPlugin.Set(
    "needsVoiceReconnect",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(NeedsVoiceReconnect)));
  mpClientPlugin.Set(
    "setVoiceParticipantPosition",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceParticipantPosition)));
  mpClientPlugin.Set(
    "setVoiceListenerPosition",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceListenerPosition)));
  mpClientPlugin.Set(
    "setVoiceRange",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceRange)));
  mpClientPlugin.Set(
    "setVoiceNoiseGateEnabled",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceNoiseGateEnabled)));
  mpClientPlugin.Set(
    "setVoiceNoiseGateThreshold",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceNoiseGateThreshold)));
  mpClientPlugin.Set(
    "setVoiceNormalizationEnabled",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceNormalizationEnabled)));
  mpClientPlugin.Set(
    "setVoiceNormalizationTarget",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetVoiceNormalizationTarget)));
  mpClientPlugin.Set(
    "getVoiceRemoteParticipants",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(GetVoiceRemoteParticipants)));
}
