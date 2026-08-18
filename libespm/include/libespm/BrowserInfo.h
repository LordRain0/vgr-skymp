#pragma once
#include <cstdint>
#include <cstddef>

namespace espm {

class CombineBrowser;

struct BrowserInfo
{
  BrowserInfo() = default;
  BrowserInfo(const CombineBrowser* parent_, size_t fileIdx_);

  // Returns 0 for empty (default constructed) LookupResult
  uint32_t ToGlobalId(uint32_t rawId) const noexcept;

  const CombineBrowser* const parent = nullptr;
  const size_t fileIdx = 0;
};

}
