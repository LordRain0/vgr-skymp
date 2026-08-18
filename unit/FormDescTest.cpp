#include "TestUtils.hpp"
#include "libespm/Utils.h"
#include "savefile/SFStructure.h"
#include <catch2/catch_all.hpp>

TEST_CASE("ToString/FromString", "[FormDesc]")
{
  REQUIRE(FormDesc(0xAAA, "").ToString() == "aaa");
  REQUIRE(FormDesc(0xAAA, "Skyrim.esm").ToString() == "aaa:Skyrim.esm");

  auto x = FormDesc::FromString("aaa");
  REQUIRE(x.file == "");
  REQUIRE(x.shortFormId == 0xAAA);

  auto v = FormDesc::FromString("aaa:Skyrim.esm");
  REQUIRE(v.file == "Skyrim.esm");
  REQUIRE(v.shortFormId == 0xAAA);
}

TEST_CASE("ToFormId/FromFormId", "[FormDesc]")
{
  std::vector<std::string> list = { "Skyrim.esm", "Update.esm" };

  REQUIRE(FormDesc::FromFormId(0x01000001, list) ==
          FormDesc(0x1, "Update.esm"));
  REQUIRE(FormDesc::FromFormId(0x00000001, list) ==
          FormDesc(0x1, "Skyrim.esm"));
  REQUIRE(FormDesc::FromFormId(0xff000bbb, list) == FormDesc(0xbbb, ""));

  REQUIRE(FormDesc(0x1, "Update.esm").ToFormId(list) == 0x01000001);
  REQUIRE(FormDesc(0x1, "Skyrim.esm").ToFormId(list) == 0x00000001);
  REQUIRE(FormDesc(0x1, "").ToFormId(list) == 0xff000001);
}

TEST_CASE("ToFormId/FromFormId supports registered light plugins",
          "[FormDesc]")
{
  std::vector<std::string> list = { "Skyrim.esm", "LightPlugin.esp",
                                    "Regular.esp" };
  std::vector<FormDesc::FileMetadata> metadata = {
    { false, 0, 0xffff },
    { true, 0xffff, 2 },
    { false, 1, 0xffff },
  };
  FormDesc::RegisterFileMetadata(&list, metadata);

  REQUIRE(FormDesc(0x812, "LightPlugin.esp").ToFormId(list) == 0xfe002812);
  REQUIRE(FormDesc::FromFormId(0xfe002812, list) ==
          FormDesc(0x812, "LightPlugin.esp"));
  REQUIRE(FormDesc(0x123, "Regular.esp").ToFormId(list) == 0x01000123);
  REQUIRE(FormDesc::FromFormId(0x01000123, list) ==
          FormDesc(0x123, "Regular.esp"));
}

TEST_CASE("ToFormId filename lookup is case-insensitive", "[FormDesc]")
{
  std::vector<std::string> list = { "Skyrim.esm", "ccBGSSSE001-Fish.esm" };

  REQUIRE(FormDesc(0x123, "ccbgssse001-fish.esm").ToFormId(list) ==
          0x01000123);
}

TEST_CASE("IdMapping maps full and light plugin ids", "[espm]")
{
  espm::IdMapping mapping;
  mapping.fill(0xff);
  mapping.SetFull(0, 1);
  mapping.SetLight(1, 3);
  mapping.SetLightRaw(3, 1);

  REQUIRE(espm::utils::GetMappedId(0x00001234, mapping) == 0x01001234);
  REQUIRE(espm::utils::GetMappedId(0x01000812, mapping) == 0xfe003812);
  REQUIRE(espm::utils::GetMappedId(0xfe003812, mapping) == 0x01000812);
}

TEST_CASE("SaveFile plugin info supports light plugin block", "[save]")
{
  SaveFile_::SaveFile save;
  save.pluginInfoSize = 1;
  save.fileLocationTable.formIDArrayCountOffset = 100;
  save.fileLocationTable.unknownTable3Offset = 100;
  save.fileLocationTable.globalDataTable1Offset = 100;
  save.fileLocationTable.globalDataTable2Offset = 100;
  save.fileLocationTable.changeFormsOffset = 100;
  save.fileLocationTable.globalDataTable3Offset = 100;

  std::vector<std::string> regular = { "Skyrim.esm", "Update.esm" };
  std::vector<std::string> light = { "LightFlagged.esp" };

  save.OverwritePluginInfo(regular, light);

  const uint32_t expectedSize =
    1 + uint32_t(2 + regular[0].size()) +
    uint32_t(2 + regular[1].size()) + 2 +
    uint32_t(2 + light[0].size());

  REQUIRE(save.pluginInfo.numPlugins == 2);
  REQUIRE(save.pluginInfo.pluginsName == regular);
  REQUIRE(save.pluginInfo.hasLightPlugins);
  REQUIRE(save.pluginInfo.numLightPlugins == 1);
  REQUIRE(save.pluginInfo.lightPluginsName == light);
  REQUIRE(save.pluginInfoSize == expectedSize);
  REQUIRE(save.fileLocationTable.formIDArrayCountOffset ==
          100 + expectedSize - 1);
  REQUIRE(save.fileLocationTable.unknownTable3Offset ==
          100 + expectedSize - 1);
  REQUIRE(save.fileLocationTable.globalDataTable1Offset ==
          100 + expectedSize - 1);
  REQUIRE(save.fileLocationTable.globalDataTable2Offset ==
          100 + expectedSize - 1);
  REQUIRE(save.fileLocationTable.changeFormsOffset == 100 + expectedSize - 1);
  REQUIRE(save.fileLocationTable.globalDataTable3Offset ==
          100 + expectedSize - 1);
}

TEST_CASE("SaveFile plugin info single-list overload preserves light esp",
          "[save]")
{
  SaveFile_::SaveFile save;
  save.pluginInfoSize = 1;
  save.pluginInfo.hasLightPlugins = true;
  save.pluginInfo.numLightPlugins = 1;
  save.pluginInfo.lightPluginsName = { "LightFlagged.esp" };

  std::vector<std::string> loadOrder = {
    "Skyrim.esm",
    "LightFlagged.esp",
    "SomeCreation.esl",
    "Regular.esp",
  };

  save.OverwritePluginInfo(loadOrder);

  REQUIRE(save.pluginInfo.pluginsName ==
          std::vector<std::string>{ "Skyrim.esm", "Regular.esp" });
  REQUIRE(save.pluginInfo.hasLightPlugins);
  REQUIRE(save.pluginInfo.lightPluginsName ==
          std::vector<std::string>{ "LightFlagged.esp", "SomeCreation.esl" });
}
