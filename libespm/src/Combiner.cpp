#include "libespm/Combiner.h"
#include "libespm/Browser.h"
#include "libespm/Convert.h"
#include "libespm/Records.h"
#include "libespm/Utils.h"
#include "libespm/espm.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <fmt/format.h>
#include <spdlog/spdlog.h>
#include <string>

namespace espm {

Combiner::Combiner()
  : pImpl(nullptr)
{
  pImpl = std::make_unique<CombineBrowser::Impl>();
}

void espm::Combiner::AddSource(Browser* src, const char* fileName) noexcept
{
  pImpl->sources.push_back({ src, fileName, nullptr });
  pImpl->numSources = pImpl->sources.size();
}

std::unique_ptr<espm::CombineBrowser> Combiner::Combine()
{
  constexpr uint32_t kTes4LightMasterFlag = 0x00000200;

  uint16_t nextFullIndex = 0;
  uint16_t nextLightIndex = 0;
  pImpl->sourceByFullIndex.fill(-1);
  pImpl->sourceByLightIndex.fill(-1);

  for (size_t i = 0; i < pImpl->numSources; ++i) {
    auto& src = pImpl->sources[i];
    if (!src.br) {
      throw CombineError("nullptr source with index " + std::to_string(i));
    }

    const auto tes4 = Convert<TES4>(src.br->LookupById(0));
    if (!tes4) {
      throw CombineError(src.fileName + " doesn't have TES4 record");
    }

    std::string fileNameLower = src.fileName;
    std::transform(fileNameLower.begin(), fileNameLower.end(),
                   fileNameLower.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    const bool hasEslExtension =
      fileNameLower.size() >= 4 &&
      fileNameLower.substr(fileNameLower.size() - 4) == ".esl";

    src.isLight = hasEslExtension || (tes4->GetFlags() & kTes4LightMasterFlag);
    if (src.isLight) {
      if (nextLightIndex >= 0x1000) {
        throw CombineError("too many light sources");
      }
      src.lightIndex = nextLightIndex++;
      pImpl->sourceByLightIndex[src.lightIndex] = static_cast<int32_t>(i);
      spdlog::info("ESPM load order: source #{} '{}' -> light slot {:#05x}",
                   i, src.fileName, src.lightIndex);
    } else {
      if (nextFullIndex >= 0xfe) {
        throw CombineError("too many full sources");
      }
      src.fullIndex = nextFullIndex++;
      pImpl->sourceByFullIndex[src.fullIndex] = static_cast<int32_t>(i);
      spdlog::info("ESPM load order: source #{} '{}' -> full slot {:#04x}", i,
                   src.fileName, src.fullIndex);
    }
  }

  for (size_t i = 0; i < pImpl->numSources; ++i) {
    auto& src = pImpl->sources[i];

    const auto tes4 = Convert<TES4>(src.br->LookupById(0));
    espm::CompressedFieldsCache dummyCache;
    const auto masters = tes4->GetData(dummyCache).masters;

    auto toComb = std::make_unique<IdMapping>();
    toComb->fill(0xff);
    auto toRaw = std::make_unique<IdMapping>();
    toRaw->fill(0xff);
    size_t m = 0;
    for (m = 0; m < masters.size(); ++m) {
      const int globalIdx = pImpl->GetFileIndex(masters[m]);
      if (globalIdx == -1) {
        throw CombineError(src.fileName + " has unresolved dependency (" +
                           masters[m] + ")");
      }
      const auto& globalSrc = pImpl->sources[globalIdx];
      if (globalSrc.isLight) {
        toComb->SetLight(m, globalSrc.lightIndex);
        toRaw->SetLightRaw(globalSrc.lightIndex, static_cast<uint16_t>(m));
      } else {
        toComb->SetFull(m, globalSrc.fullIndex);
        toRaw->SetFull(globalSrc.fullIndex, static_cast<uint16_t>(m));
      }
    }
    if (src.isLight) {
      toComb->SetLight(m, src.lightIndex);
      toRaw->SetLightRaw(src.lightIndex, static_cast<uint16_t>(m));
    } else {
      toComb->SetFull(m, src.fullIndex);
      toRaw->SetFull(src.fullIndex, static_cast<uint16_t>(m));
    }
    src.toComb = std::move(toComb);
    src.toRaw = std::move(toRaw);
  }

  std::unique_ptr<espm::CombineBrowser> res(new CombineBrowser);
  res->pImpl = pImpl;
  return res;
}

Combiner::~Combiner() = default;

}
