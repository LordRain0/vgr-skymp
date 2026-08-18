#include "HttpClient.h"
#include "TaskQueue.h"
#include "ThreadPoolWrapper.h"
#include <array>
#include <exception>
#include <filesystem>

#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

namespace {
inline httplib::Headers CastHeaders(const HttpClient::Headers& headers)
{
  httplib::Headers res;
  for (auto& p : headers) {
    res.insert(p);
  }
  return res;
}

std::string MakeExceptionError(const char* context, const std::exception& e)
{
  std::string error = context;
  error += ": ";
  error += e.what();
  return error;
}

std::string MakeUnknownExceptionError(const char* context)
{
  std::string error = context;
  error += ": unknown exception";
  return error;
}

HttpClient::HttpResult MakeErrorResult(std::string error)
{
  HttpClient::HttpResult result;
  result.status = 0;
  result.error = std::move(error);
  return result;
}

HttpClient::HttpResult MakeHttpResult(const httplib::Result& res)
{
  HttpClient::HttpResult result;
  if (res) {
    result.body.assign(res->body.begin(), res->body.end());
    result.status = res->status;
  } else {
    result.status = 0;
    result.error = to_string(res.error());
  }
  return result;
}

std::string FindBundledCaCertPath()
{
  const std::array<std::filesystem::path, 4> candidates = {
    std::filesystem::path("Data") / "Platform" / "Distribution" /
      "RuntimeDependencies" / "cacert.pem",
    std::filesystem::path("Data") / "Platform" / "cacert.pem",
    std::filesystem::path("Platform") / "Distribution" /
      "RuntimeDependencies" / "cacert.pem",
    std::filesystem::path("cacert.pem"),
  };

  for (const auto& candidate : candidates) {
    try {
      std::error_code ec;
      const auto absolutePath = std::filesystem::absolute(candidate, ec);
      if (ec) {
        continue;
      }

      ec.clear();
      if (std::filesystem::is_regular_file(absolutePath, ec) && !ec) {
        return absolutePath.string();
      }
    } catch (const std::exception&) {
      continue;
    } catch (...) {
      continue;
    }
  }

  return {};
}

std::string ConfigureTls(httplib::Client& client)
{
  try {
    client.enable_server_certificate_verification(true);

    const auto caCertPath = FindBundledCaCertPath();
    if (!caCertPath.empty()) {
      client.set_ca_cert_path(caCertPath);
    }

    return {};
  } catch (const std::exception& e) {
    return MakeExceptionError("TLS configuration failed", e);
  } catch (...) {
    return MakeUnknownExceptionError("TLS configuration failed");
  }
}
}

struct HttpClient::Impl
{
  Impl()
    : pool(3)
  {
  }

  Viet::TaskQueue<Napi::Env> q;
  ThreadPoolWrapper pool;
};

HttpClient::HttpClient()
{
  pImpl.reset(new Impl);
}

void HttpClient::ExecuteQueuedCallbacks(Napi::Env env)
{
  pImpl->q.Update(env);
}

void HttpClient::Get(const char* host, const char* path,
                     const Headers& headers, OnComplete callback)
{
  auto pImpl_ = pImpl;
  auto queueResult = [pImpl_, callback](HttpResult result) {
    pImpl_->q.AddTask(
      [callback, result = std::move(result)](Napi::Env env) mutable {
        callback(env, std::move(result));
      });
  };
  auto queueError = [queueResult](std::string error) {
    queueResult(MakeErrorResult(std::move(error)));
  };

  if (!host || !host[0]) {
    queueError("HTTP host is empty");
    return;
  }
  if (!path) {
    queueError("HTTP path is null");
    return;
  }
  if (path[0] && path[0] != '/') {
    queueError("HTTP paths must start with '/'");
    return;
  }

  std::string path_ = path;
  std::shared_ptr<httplib::Client> cl;
  try {
    cl = std::make_shared<httplib::Client>(host);
    const auto tlsError = ConfigureTls(*cl);
    if (!tlsError.empty()) {
      queueError(tlsError);
      return;
    }
  } catch (const std::exception& e) {
    queueError(MakeExceptionError("HTTP client creation failed", e));
    return;
  } catch (...) {
    queueError(MakeUnknownExceptionError("HTTP client creation failed"));
    return;
  }

  try {
    pImpl->pool.Push([cl, path_, headers, queueResult, queueError] {
      try {
        const httplib::Result res = cl->Get(path_.data(), CastHeaders(headers));
        queueResult(MakeHttpResult(res));
      } catch (const std::exception& e) {
        queueError(MakeExceptionError("HTTP GET failed", e));
      } catch (...) {
        queueError(MakeUnknownExceptionError("HTTP GET failed"));
      }
    });
  } catch (const std::exception& e) {
    queueError(MakeExceptionError("HTTP GET scheduling failed", e));
  } catch (...) {
    queueError(MakeUnknownExceptionError("HTTP GET scheduling failed"));
  }
}

void HttpClient::Post(const char* host, const char* path, const char* body,
                      const char* contentType, const Headers& headers,
                      OnComplete callback)
{
  auto pImpl_ = pImpl;
  auto queueResult = [pImpl_, callback](HttpResult result) {
    pImpl_->q.AddTask(
      [callback, result = std::move(result)](Napi::Env env) mutable {
        callback(env, std::move(result));
      });
  };
  auto queueError = [queueResult](std::string error) {
    queueResult(MakeErrorResult(std::move(error)));
  };

  if (!host || !host[0]) {
    queueError("HTTP host is empty");
    return;
  }
  if (!path) {
    queueError("HTTP path is null");
    return;
  }
  if (path[0] && path[0] != '/') {
    queueError("HTTP paths must start with '/'");
    return;
  }

  std::string path_ = path;
  std::string body_ = body ? body : "";
  std::string contentType_ = contentType ? contentType : "";
  std::shared_ptr<httplib::Client> cl;
  try {
    cl = std::make_shared<httplib::Client>(host);
    const auto tlsError = ConfigureTls(*cl);
    if (!tlsError.empty()) {
      queueError(tlsError);
      return;
    }
  } catch (const std::exception& e) {
    queueError(MakeExceptionError("HTTP client creation failed", e));
    return;
  } catch (...) {
    queueError(MakeUnknownExceptionError("HTTP client creation failed"));
    return;
  }

  try {
    pImpl->pool.Push(
      [cl, path_, body_, contentType_, headers, queueResult, queueError] {
        try {
          const httplib::Result res =
            cl->Post(path_.data(), CastHeaders(headers), body_.data(),
                     body_.size(), contentType_.data());
          queueResult(MakeHttpResult(res));
        } catch (const std::exception& e) {
          queueError(MakeExceptionError("HTTP POST failed", e));
        } catch (...) {
          queueError(MakeUnknownExceptionError("HTTP POST failed"));
        }
      });
  } catch (const std::exception& e) {
    queueError(MakeExceptionError("HTTP POST scheduling failed", e));
  } catch (...) {
    queueError(MakeUnknownExceptionError("HTTP POST scheduling failed"));
  }
}
