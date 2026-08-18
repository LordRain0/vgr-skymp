#pragma once
#include "CellOrGridPos.h"
#include "GroupStack.h"
#include "IdMapping.h"
#include "LookupResult.h"
#include <array>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace espm {

class RecordHeader;
class Browser;

class CombineBrowser
{
  friend class Combiner;

public:
  // Returns default constructed LookupResult on failure
  // Gets record from the last file in the load order
  LookupResult LookupById(uint32_t formId) const noexcept;

  // Returns a record for each file adding/editing record with such id
  std::vector<LookupResult> LookupByIdAll(uint32_t formId) const noexcept;

  std::pair<const RecordHeader**, size_t> FindNavMeshes(
    uint32_t worldSpaceId, CellOrGridPos cellOrGridPos) const noexcept;

  std::vector<const std::vector<const RecordHeader*>*> GetRecordsByType(
    const char* type) const;

  const std::vector<LookupResult>& GetDistinctRecordsByType(
    const char* type) const;

  void PrewarmCaches(const std::vector<std::string>& recordTypes) const;

  std::vector<const std::vector<const RecordHeader*>*> GetRecordsAtPos(
    uint32_t cellOrWorld, int16_t cellX, int16_t cellY) const;

  const std::vector<const RecordHeader*>* GetRecordsAtPos(
    size_t fileIndex, uint32_t rawCellOrWorld, int16_t cellX,
    int16_t cellY) const noexcept;

  struct SourceRecordsAtPos
  {
    size_t fileIndex = 0;
    const std::vector<const RecordHeader*>* records = nullptr;
  };

  const std::vector<SourceRecordsAtPos>& GetSourceRecordsAtPos(
    uint32_t cellOrWorld, int16_t cellX, int16_t cellY) const;

  bool IsLight(size_t fileIndex) const noexcept;
  uint16_t GetFullIndex(size_t fileIndex) const noexcept;
  uint16_t GetLightIndex(size_t fileIndex) const noexcept;
  int32_t GetFileIndexByFormId(uint32_t formId) const noexcept;

  // Returns nullptr on failure
  const IdMapping* GetCombMapping(size_t fileIndex) const noexcept;
  const IdMapping* GetRawMapping(size_t fileIndex) const noexcept;

  // CompressedFieldsCache is not logically related to Combiner, this method is
  // added for usability
  espm::CompressedFieldsCache& GetCache() const noexcept;

  const GroupStack& GetParentGroupsEnsured(const RecordHeader* rec) const;
  const std::vector<const void*>& GetSubsEnsured(
    const GroupHeader* group) const;

private:
  struct Source
  {
    Browser* br = nullptr;
    std::string fileName;
    std::unique_ptr<espm::IdMapping> toComb, toRaw;
    bool isLight = false;
    uint16_t fullIndex = 0xffff;
    uint16_t lightIndex = 0xffff;
  };

  struct Impl
  {
    CompressedFieldsCache cache;

    std::vector<Source> sources;
    std::array<int32_t, 256> sourceByFullIndex{};
    std::array<int32_t, 4096> sourceByLightIndex{};
    mutable std::unordered_map<uint32_t, LookupResult> lookupByIdCache;
    mutable std::unordered_map<std::string, std::vector<LookupResult>>
      distinctRecordsByTypeCache;
    mutable std::unordered_map<uint64_t, std::vector<SourceRecordsAtPos>>
      recordsAtPosCache;
    size_t numSources = 0;
    int32_t GetFileIndex(const char* fileName) const noexcept;
  };
  std::shared_ptr<Impl> pImpl;

  CombineBrowser() = default;
  CombineBrowser(const CombineBrowser&) = delete;
  void operator=(const CombineBrowser&) = delete;
};

}
