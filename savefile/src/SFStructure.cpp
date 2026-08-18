#include "savefile/SFStructure.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <unordered_set>

namespace {
uint32_t GetPluginNamesSize(const std::vector<std::string>& pluginNames)
{
  uint32_t size = 0;
  for (auto& plugin : pluginNames) {
    size += uint32_t(2 + plugin.size());
  }
  return size;
}

std::string ToLower(std::string s)
{
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return s;
}

bool HasEslExtension(const std::string& pluginName)
{
  const auto lower = ToLower(pluginName);
  return lower.size() >= 4 && lower.substr(lower.size() - 4) == ".esl";
}

std::unordered_set<std::string> GetLowerPluginNameSet(
  const std::vector<std::string>& pluginNames)
{
  std::unordered_set<std::string> res;
  for (const auto& pluginName : pluginNames) {
    res.insert(ToLower(pluginName));
  }
  return res;
}

void ApplyPluginInfoSizeDiff(SaveFile_::SaveFile& save, uint32_t oldSize)
{
  const auto addSize = static_cast<int64_t>(save.pluginInfoSize) -
    static_cast<int64_t>(oldSize);

  save.fileLocationTable.formIDArrayCountOffset += addSize;
  save.fileLocationTable.unknownTable3Offset += addSize;
  save.fileLocationTable.globalDataTable1Offset += addSize;
  save.fileLocationTable.globalDataTable2Offset += addSize;
  save.fileLocationTable.changeFormsOffset += addSize;
  save.fileLocationTable.globalDataTable3Offset += addSize;
}
}

SaveFile_::RefID SaveFile_::RefID::CreateRefId(SaveFile& parentSaveFile,
                                               uint32_t formId)
{
  RefID res;

  auto existing =
    std::find(parentSaveFile.formIDArray.begin(),
              parentSaveFile.formIDArray.end(), formId);
  const auto index = existing != parentSaveFile.formIDArray.end()
    ? static_cast<size_t>(std::distance(parentSaveFile.formIDArray.begin(),
                                        existing)) +
      1
    : parentSaveFile.formIDArray.size() + 1;

  if (existing == parentSaveFile.formIDArray.end()) {
    parentSaveFile.formIDArray.push_back(formId);
    parentSaveFile.formIDArrayCount =
      static_cast<uint32_t>(parentSaveFile.formIDArray.size());

    // fix offset
    parentSaveFile.fileLocationTable.unknownTable3Offset += 4;
  }

  // 255 => 00 00 FF
  // 256 => 00 01 00
  // 65536 => error
  // as uesp.net says, formIDArray index starts in 1
  if (index >= 65536)
    throw std::runtime_error("too many elements was in FormIDArray (" +
                             std::to_string(parentSaveFile.formIDArray.size()) +
                             ")");
  res.byte0 = 0;
  res.byte1 = (index / 256) % 256;
  res.byte2 = index % 256;

  return res;
}

SaveFile_::ChangeForm* SaveFile_::SaveFile::GetChangeFormByRefID(
  SaveFile_::RefID refID, const uint8_t& type)
{
  for (auto& form : this->changeForms) {
    if ((form.type & 0b00111111) == type &&
        form.formID == refID) /// Upper 2 bits represent the size of the data
                              /// lengths: zero them
      return &form;
  }
  return nullptr;
}

SaveFile_::GlobalVariables::GlobalVariable*
SaveFile_::SaveFile::GetGlobalvariableByRefID(SaveFile_::RefID& refID)
{
  GlobalData& gData = this->globalDataTable1[GLOBAL_VARIABLES_INDEX];

  if (gData.type != GLOBAL_VARIABLES_INDEX)
    return nullptr;

  GlobalVariables* globalsVar =
    reinterpret_cast<GlobalVariables*>(gData.data.get());

  if (!globalsVar)
    return nullptr;

  for (auto& gVar : globalsVar->globals) {
    if (gVar.formID == refID) {
      return &gVar;
    }
  }
  return nullptr;
}

int64_t SaveFile_::SaveFile::FindIndexInFormIdArray(uint32_t refID)
{
  for (uint32_t i = 0; i < this->formIDArray.size(); ++i) {
    if (this->formIDArray[i] == refID) {
      return i;
    }
  }
  return -1;
}

void SaveFile_::SaveFile::OverwritePluginInfo(
  std::vector<std::string>& newPluginNames)
{
  std::vector<std::string> plugins;
  std::vector<std::string> lightPlugins;
  const auto knownLightPlugins =
    GetLowerPluginNameSet(this->pluginInfo.lightPluginsName);

  for (auto& plugin : newPluginNames) {
    if (HasEslExtension(plugin) ||
        knownLightPlugins.count(ToLower(plugin)) != 0) {
      lightPlugins.push_back(plugin);
    } else {
      plugins.push_back(plugin);
    }
  }

  OverwritePluginInfo(plugins, lightPlugins);
}

void SaveFile_::SaveFile::OverwritePluginInfo(
  std::vector<std::string>& newPluginNames,
  std::vector<std::string>& newLightPluginNames)
{
  uint32_t oldSize = this->pluginInfoSize;

  this->pluginInfoSize = 1;
  this->pluginInfo.numPlugins = 0;
  this->pluginInfo.pluginsName.clear();
  this->pluginInfo.hasLightPlugins =
    this->pluginInfo.hasLightPlugins || !newLightPluginNames.empty();
  this->pluginInfo.numLightPlugins = 0;
  this->pluginInfo.lightPluginsName.clear();

  this->pluginInfo.numPlugins = static_cast<uint8_t>(newPluginNames.size());
  if (newPluginNames.size() > 0xff) {
    throw std::runtime_error("too many regular plugins (" +
                             std::to_string(newPluginNames.size()) + ")");
  }

  for (auto& plugin : newPluginNames) {
    this->pluginInfo.pluginsName.push_back(plugin);
  }
  this->pluginInfoSize += GetPluginNamesSize(this->pluginInfo.pluginsName);

  if (this->pluginInfo.hasLightPlugins) {
    if (newLightPluginNames.size() > 0xffff) {
      throw std::runtime_error("too many light plugins (" +
                               std::to_string(newLightPluginNames.size()) +
                               ")");
    }
    this->pluginInfoSize += 2;
    this->pluginInfo.numLightPlugins =
      static_cast<uint16_t>(newLightPluginNames.size());
    for (auto& plugin : newLightPluginNames) {
      this->pluginInfo.lightPluginsName.push_back(plugin);
    }
    this->pluginInfoSize +=
      GetPluginNamesSize(this->pluginInfo.lightPluginsName);
  }

  ApplyPluginInfoSizeDiff(*this, oldSize);
}
