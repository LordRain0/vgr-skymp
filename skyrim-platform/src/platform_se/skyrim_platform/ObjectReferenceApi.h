#pragma once

#include "NapiHelper.h"

namespace ObjectReferenceApi {

Napi::Value IsPickupableItem(const Napi::CallbackInfo& info);
Napi::Value SetCollision(const Napi::CallbackInfo& info);

inline void Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set("isPickupableItem",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(IsPickupableItem)));
  exports.Set(
    "setCollision",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetCollision)));
}
}
