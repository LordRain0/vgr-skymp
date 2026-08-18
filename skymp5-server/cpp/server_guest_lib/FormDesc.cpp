#include "FormDesc.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <unordered_map>

namespace {
struct FileMetadataCache
{
  std::vector<FormDesc::FileMetadata> metadata;
  std::unordered_map<std::string, size_t> fileIndexByName;
  std::array<size_t, 256> fileIndexByFullIndex{};
  std::array<size_t, 4096> fileIndexByLightIndex{};

  FileMetadataCache()
  {
    fileIndexByFullIndex.fill(kInvalidFileIndex);
    fileIndexByLightIndex.fill(kInvalidFileIndex);
  }

  static constexpr size_t kInvalidFileIndex =
    std::numeric_limits<size_t>::max();
};

std::string ToLower(std::string_view str)
{
  std::string res(str);
  std::transform(res.begin(), res.end(), res.begin(), [](unsigned char c) {
    return std::tolower(c);
  });
  return res;
}

std::unordered_map<const std::vector<std::string>*, FileMetadataCache>&
GetMetadataRegistry()
{
  static auto* registry =
    new std::unordered_map<const std::vector<std::string>*,
                           FileMetadataCache>();
  return *registry;
}

const FileMetadataCache* GetMetadata(
  const std::vector<std::string>& files)
{
  const auto& registry = GetMetadataRegistry();
  const auto it = registry.find(&files);
  return it == registry.end() ? nullptr : &it->second;
}

bool EqualsIgnoreCase(std::string_view lhs, std::string_view rhs)
{
  return lhs.size() == rhs.size() &&
    std::equal(lhs.begin(), lhs.end(), rhs.begin(), [](char a, char b) {
      return std::tolower(static_cast<unsigned char>(a)) ==
        std::tolower(static_cast<unsigned char>(b));
    });
}
}

std::string FormDesc::ToString(char delimiter) const
{
  auto fullFmt = "%0x%c%s";
  auto idFmt = "%0x";
  size_t size = !file.empty()
    ? std::snprintf(nullptr, 0, fullFmt, shortFormId, delimiter, file.c_str())
    : std::snprintf(nullptr, 0, idFmt, shortFormId);

  std::string buffer;
  buffer.resize(size + 1);

  if (!file.empty()) {
    std::sprintf(buffer.data(), fullFmt, shortFormId, delimiter, file.c_str());
  } else {
    std::sprintf(buffer.data(), idFmt, shortFormId);
  }
  buffer.resize(size); // remove extra null terminator
  return buffer;
}

FormDesc FormDesc::FromString(const std::string& str, char delimiter)
{
  FormDesc res;
  std::string id, file;

  if (str.find(delimiter) == std::string::npos) {
    std::sscanf(str.data(), "%x", &res.shortFormId);
    return res;
  }

  for (auto it = str.begin(); it != str.end(); ++it) {
    if (*it == delimiter) {
      id = { str.begin(), it };
      res.file = { it + 1, str.end() };
      break;
    }
  }

  std::sscanf(id.data(), "%x", &res.shortFormId);
  return res;
}

uint32_t FormDesc::ToFormId(const std::vector<std::string>& files) const
{
  // Workaround legacy tests throwing exceptions (drop support for PartOne
  // instances without espm to remove this)
  static const std::string kSkyrimEsm = "Skyrim.esm";
  if (shortFormId == 0x3c && file == kSkyrimEsm) {
    return 0x3c;
  }

  uint32_t realFormId;
  if (file.empty()) {
    realFormId = 0xff000000 + shortFormId;
  } else {
    int fileIdx = -1;
    const auto metadataCache = GetMetadata(files);
    if (metadataCache) {
      const auto it = metadataCache->fileIndexByName.find(ToLower(file));
      if (it != metadataCache->fileIndexByName.end()) {
        fileIdx = static_cast<int>(it->second);
      }
    } else {
      int numFiles = static_cast<int>(files.size());
      for (int i = 0; i < numFiles; ++i) {
        if (EqualsIgnoreCase(files[i], file)) {
          fileIdx = i;
          break;
        }
      }
    }

    if (fileIdx == -1) {
      throw std::runtime_error(file + " not found in loaded files");
    }

    if (metadataCache) {
      if (fileIdx < static_cast<int>(metadataCache->metadata.size())) {
        const auto& fileMetadata = metadataCache->metadata[fileIdx];
        if (fileMetadata.isLight) {
          realFormId = 0xfe000000 +
            (static_cast<uint32_t>(fileMetadata.lightIndex) << 12) +
            (shortFormId & 0xfff);
        } else {
          realFormId =
            fileMetadata.fullIndex * 0x01000000 + shortFormId;
        }
      } else {
        realFormId = fileIdx * 0x01000000 + shortFormId;
      }
    } else {
      realFormId = fileIdx * 0x01000000 + shortFormId;
    }
  }
  return realFormId;
}

FormDesc FormDesc::FromFormId(uint32_t formId,
                              const std::vector<std::string>& files)
{
  // Workaround legacy tests throwing exceptions (drop support for PartOne
  // instances without espm to remove this)
  if (formId == 0x3c) {
    return FormDesc::Tamriel();
  }

  FormDesc res;
  if (const auto metadataCache = GetMetadata(files)) {
    const uint8_t fullIndex = static_cast<uint8_t>(formId >> 24);
    const bool isLight = fullIndex == 0xfe;
    const uint16_t lightIndex =
      static_cast<uint16_t>((formId >> 12) & 0xfff);
    const auto fileIdx = isLight
      ? metadataCache->fileIndexByLightIndex[lightIndex]
      : metadataCache->fileIndexByFullIndex[fullIndex];
    if (fileIdx != FileMetadataCache::kInvalidFileIndex &&
        fileIdx < files.size()) {
      res.file = files[fileIdx];
      res.shortFormId = isLight ? (formId & 0xfff) : (formId % 0x01000000);
      return res;
    }
  }

  if (formId < 0xff000000) {
    int fileIdx = formId / 0x01000000;
    if (fileIdx >= static_cast<int>(files.size())) {
      throw std::runtime_error("FromFormId failed due to invalid file index " +
                               std::to_string(fileIdx));
    }
    res.file = files[fileIdx];
    res.shortFormId = formId % 0x01000000;
  } else {
    res.shortFormId = formId - 0xff000000;
  }
  return res;
}

void FormDesc::RegisterFileMetadata(
  const std::vector<std::string>* files,
  const std::vector<FileMetadata>& metadata)
{
  FileMetadataCache cache;
  cache.metadata = metadata;

  for (size_t i = 0; i < files->size(); ++i) {
    cache.fileIndexByName.emplace(ToLower((*files)[i]), i);
    if (i >= metadata.size()) {
      continue;
    }

    const auto& fileMetadata = metadata[i];
    if (fileMetadata.isLight) {
      if (fileMetadata.lightIndex < cache.fileIndexByLightIndex.size()) {
        cache.fileIndexByLightIndex[fileMetadata.lightIndex] = i;
      }
    } else if (fileMetadata.fullIndex < cache.fileIndexByFullIndex.size()) {
      cache.fileIndexByFullIndex[fileMetadata.fullIndex] = i;
    }
  }

  GetMetadataRegistry()[files] = std::move(cache);
}

static const FormDesc kTamriel = FormDesc::FromString("3c:Skyrim.esm");

FormDesc FormDesc::Tamriel()
{
  return kTamriel;
}
