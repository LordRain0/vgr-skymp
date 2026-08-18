#include "libespm/CombineBrowser.h"
#include "libespm/Browser.h"
#include "libespm/RecordHeader.h"
#include "libespm/Utils.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <fmt/format.h>
#include <memory>
#include <string_view>
#include <unordered_set>

namespace espm {
namespace {
uint64_t MakeRecordsAtPosCacheKey(uint32_t cellOrWorld, int16_t cellX,
                                  int16_t cellY) noexcept
{
  const uint32_t packedPos =
    (static_cast<uint32_t>(static_cast<uint16_t>(cellX)) << 16) |
    static_cast<uint16_t>(cellY);
  return utils::MakeUInt64(cellOrWorld, packedPos);
}

bool EqualIgnoreCase(std::string_view a, std::string_view b) noexcept
{
  return a.size() == b.size() &&
    std::equal(a.begin(), a.end(), b.begin(), [](char lhs, char rhs) {
      return std::tolower(static_cast<unsigned char>(lhs)) ==
        std::tolower(static_cast<unsigned char>(rhs));
    });
}
}

int32_t CombineBrowser::Impl::GetFileIndex(const char* fileName) const noexcept
{
  // returns index of sources array or -1 if not found
  if (fileName[0] != '\0') {
    for (size_t i = 0; i < numSources; ++i) {
      if (EqualIgnoreCase(sources[i].fileName, fileName)) {
        return i;
      }
    }
  }
  return -1;
}

LookupResult CombineBrowser::LookupById(uint32_t combFormId) const noexcept
{
  // Otherwise, we'll find a TES4 record in Skyrim.esm which is not relevant
  // for CombineBrowser use cases
  if (combFormId == 0) {
    return LookupResult();
  }

  auto cacheIt = pImpl->lookupByIdCache.find(combFormId);
  if (cacheIt != pImpl->lookupByIdCache.end()) {
    return cacheIt->second;
  }

  const RecordHeader* resRec = nullptr;
  size_t resFileIdx = 0;
  for (size_t i = 0; i < pImpl->numSources; ++i) {
    auto& src = pImpl->sources[i];
    const uint32_t rawFormId = utils::GetMappedId(combFormId, *src.toRaw);
    if (rawFormId >= 0xff000000)
      continue;
    auto rec = src.br->LookupById(rawFormId);
    if (rec) {
      resRec = rec;
      resFileIdx = i;
    }
  }
  auto result =
    resRec ? LookupResult(this, resRec, resFileIdx) : LookupResult();
  try {
    pImpl->lookupByIdCache.emplace(combFormId, result);
  } catch (...) {
    // LookupById is noexcept. Cache insertion is an optimization only, so keep
    // returning the computed result if allocation fails.
  }
  return result;
}

std::vector<LookupResult> CombineBrowser::LookupByIdAll(
  uint32_t combFormId) const noexcept
{
  std::vector<LookupResult> res;
  for (size_t i = 0; i < pImpl->numSources; ++i) {
    auto& src = pImpl->sources[i];
    const uint32_t rawFormId = utils::GetMappedId(combFormId, *src.toRaw);
    if (rawFormId >= 0xff000000)
      continue;
    const RecordHeader* rec = src.br->LookupById(rawFormId);
    if (rec) {
      res.push_back({ this, rec, i });
    }
  }
  return res;
}

std::pair<const RecordHeader**, size_t> CombineBrowser::FindNavMeshes(
  uint32_t worldSpaceId, CellOrGridPos cellOrGridPos) const noexcept
{
  for (size_t i = 0; i < pImpl->numSources; ++i) {
    auto& src = pImpl->sources[i];
    const uint32_t rawFormId = utils::GetMappedId(worldSpaceId, *src.toRaw);
    if (rawFormId >= 0xff000000)
      continue;
    auto p = src.br->FindNavMeshes(rawFormId, cellOrGridPos);
    auto front = p.first;
    auto size = p.second;
    if (front && *front) {
      return { front, size };
    }
  }
  return { nullptr, 0 };
}

std::vector<const std::vector<const RecordHeader*>*>
CombineBrowser::GetRecordsByType(const char* type) const
{
  std::vector<const std::vector<const RecordHeader*>*> res;
  for (size_t i = 0; i < pImpl->numSources; ++i) {
    res.push_back(&pImpl->sources[i].br->GetRecordsByType(type));
  }
  return res;
}

const std::vector<LookupResult>& CombineBrowser::GetDistinctRecordsByType(
  const char* type) const
{
  static const std::vector<LookupResult> kEmptyResult;
  if (pImpl->numSources == 0) {
    return kEmptyResult;
  }

  const std::string typeKey(type);
  auto cacheIt = pImpl->distinctRecordsByTypeCache.find(typeKey);
  if (cacheIt != pImpl->distinctRecordsByTypeCache.end()) {
    return cacheIt->second;
  }

  std::unordered_set<formId> formSet;
  std::vector<LookupResult> result;
  for (size_t i = pImpl->numSources - 1; i != static_cast<size_t>(-1); --i) {
    const auto& records = pImpl->sources[i].br->GetRecordsByType(type);
    formSet.reserve(formSet.size() + records.size());
    result.reserve(result.size() + records.size());

    for (auto record : records) {
      auto mappedId =
        utils::GetMappedId(record->GetId(), *pImpl->sources[i].toComb);
      if (formSet.insert(mappedId).second) {
        result.push_back(LookupResult(this, record, i));
      }
    }
  }

  auto inserted =
    pImpl->distinctRecordsByTypeCache.emplace(typeKey, std::move(result));
  return inserted.first->second;
}

void CombineBrowser::PrewarmCaches(
  const std::vector<std::string>& recordTypes) const
{
  for (const auto& recordType : recordTypes) {
    GetDistinctRecordsByType(recordType.c_str());
  }
}

std::vector<const std::vector<const RecordHeader*>*>
CombineBrowser::GetRecordsAtPos(uint32_t cellOrWorld, int16_t cellX,
                                int16_t cellY) const
{
  std::vector<const std::vector<const RecordHeader*>*> res;
  for (size_t i = 0; i < pImpl->numSources; ++i) {
    res.push_back(
      &pImpl->sources[i].br->GetRecordsAtPos(cellOrWorld, cellX, cellY));
  }
  return res;
}

const std::vector<const RecordHeader*>* CombineBrowser::GetRecordsAtPos(
  size_t fileIndex, uint32_t rawCellOrWorld, int16_t cellX,
  int16_t cellY) const noexcept
{
  if (fileIndex >= pImpl->numSources || rawCellOrWorld >= 0xff000000) {
    return nullptr;
  }

  return &pImpl->sources[fileIndex].br->GetRecordsAtPos(rawCellOrWorld, cellX,
                                                        cellY);
}

const std::vector<CombineBrowser::SourceRecordsAtPos>&
CombineBrowser::GetSourceRecordsAtPos(uint32_t cellOrWorld, int16_t cellX,
                                      int16_t cellY) const
{
  const auto cacheKey = MakeRecordsAtPosCacheKey(cellOrWorld, cellX, cellY);
  auto it = pImpl->recordsAtPosCache.find(cacheKey);
  if (it != pImpl->recordsAtPosCache.end()) {
    return it->second;
  }

  std::vector<SourceRecordsAtPos> res;
  for (size_t i = 0; i < pImpl->numSources; ++i) {
    const auto& src = pImpl->sources[i];
    const uint32_t rawCellOrWorld =
      utils::GetMappedId(cellOrWorld, *src.toRaw);
    if (rawCellOrWorld >= 0xff000000) {
      continue;
    }

    const auto& records =
      src.br->GetRecordsAtPos(rawCellOrWorld, cellX, cellY);
    if (!records.empty()) {
      res.push_back({ i, &records });
    }
  }

  auto inserted =
    pImpl->recordsAtPosCache.emplace(cacheKey, std::move(res));
  return inserted.first->second;
}

bool CombineBrowser::IsLight(size_t fileIndex) const noexcept
{
  return fileIndex < pImpl->numSources && pImpl->sources[fileIndex].isLight;
}

uint16_t CombineBrowser::GetFullIndex(size_t fileIndex) const noexcept
{
  if (fileIndex >= pImpl->numSources) {
    return 0xffff;
  }
  return pImpl->sources[fileIndex].fullIndex;
}

uint16_t CombineBrowser::GetLightIndex(size_t fileIndex) const noexcept
{
  if (fileIndex >= pImpl->numSources) {
    return 0xffff;
  }
  return pImpl->sources[fileIndex].lightIndex;
}

int32_t CombineBrowser::GetFileIndexByFormId(uint32_t formId) const noexcept
{
  const uint8_t fullIndex = static_cast<uint8_t>(formId >> 24);
  if (fullIndex == 0xfe) {
    const uint16_t lightIndex = static_cast<uint16_t>((formId >> 12) & 0xfff);
    return pImpl->sourceByLightIndex[lightIndex];
  }

  return pImpl->sourceByFullIndex[fullIndex];
}

const IdMapping* CombineBrowser::GetCombMapping(
  size_t fileIndex) const noexcept
{
  if (fileIndex >= pImpl->numSources) {
    return nullptr;
  }
  return pImpl->sources[fileIndex].toComb.get();
}

const IdMapping* CombineBrowser::GetRawMapping(size_t fileIndex) const noexcept
{
  if (fileIndex >= pImpl->numSources) {
    return nullptr;
  }
  return pImpl->sources[fileIndex].toRaw.get();
}

CompressedFieldsCache& CombineBrowser::GetCache() const noexcept
{
  return pImpl->cache;
}

const GroupStack& CombineBrowser::GetParentGroupsEnsured(
  const RecordHeader* rec) const
{
  for (size_t i = 0; i < pImpl->numSources; ++i) {
    const auto result = pImpl->sources[i].br->GetParentGroupsOptional(rec);
    if (result) {
      return *result;
    }
  }
  throw std::runtime_error(fmt::format(
    "espm::CombineBrowser: no browsers know record id={:#x}", rec->GetId()));
}

const std::vector<const void*>& CombineBrowser::GetSubsEnsured(
  const GroupHeader* group) const
{
  for (size_t i = 0; i < pImpl->numSources; ++i) {
    const auto result = pImpl->sources[i].br->GetSubsOptional(group);
    if (result) {
      return *result;
    }
  }
  throw std::runtime_error(
    "espm::CombineBrowser: no browsers know requested group");
}

}
