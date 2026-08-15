#pragma once

#include "NapiHelper.h"

namespace CellDebugApi {

Napi::Value GetCellEnvironmentDebugData(const Napi::CallbackInfo& info);

inline void Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set(
    "getCellEnvironmentDebugData",
    Napi::Function::New(
      env, NapiHelper::WrapCppExceptions(GetCellEnvironmentDebugData)));
}
}
