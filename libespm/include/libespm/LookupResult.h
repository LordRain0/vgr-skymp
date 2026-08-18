#pragma once
#include "BrowserInfo.h"
#include "RecordHeader.h"

namespace espm {

struct LookupResult : public BrowserInfo
{
  LookupResult() = default;
  LookupResult(const CombineBrowser* parent_, const RecordHeader* rec_,
               size_t fileIdx_);

  const RecordHeader* const rec = nullptr;
};

}
