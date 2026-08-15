# LiveKit C++ SDK overlay port
#
# This port downloads prebuilt LiveKit C++ SDK binaries from GitHub releases.
# The SDK wraps the Rust FFI layer (liblivekit_ffi) and provides a clean
# C++ API for audio/video/data communication via LiveKit.
#
# To build from source instead, clone https://github.com/livekit/client-sdk-cpp
# and follow their build instructions (requires Rust toolchain).

vcpkg_check_linkage(ONLY_DYNAMIC_LIBRARY)

set(LIVEKIT_VERSION "0.3.4")
set(LIVEKIT_REPO "livekit/client-sdk-cpp")

# Download prebuilt release archive
vcpkg_download_distfile(ARCHIVE
    URLS "https://github.com/${LIVEKIT_REPO}/releases/download/v${LIVEKIT_VERSION}/livekit-sdk-windows-x64-${LIVEKIT_VERSION}.zip"
    FILENAME "livekit-sdk-windows-x64-${LIVEKIT_VERSION}.zip"
    SHA512 b3534ade2278a57025f64bc2e86770d1e69a3d35dfe010b28a11aa20610386499ead979629b5a7764594c1e83530f398863ef44c56df971247f8acd188f7226c
)

vcpkg_extract_source_archive(SOURCE_PATH
    ARCHIVE "${ARCHIVE}"
)

# Install headers
file(INSTALL "${SOURCE_PATH}/include/" DESTINATION "${CURRENT_PACKAGES_DIR}/include")

# Install release libraries
file(INSTALL "${SOURCE_PATH}/lib/livekit.lib" DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
file(INSTALL "${SOURCE_PATH}/lib/livekit_ffi.dll.lib" DESTINATION "${CURRENT_PACKAGES_DIR}/lib")

# Install DLLs
file(INSTALL "${SOURCE_PATH}/bin/livekit.dll" DESTINATION "${CURRENT_PACKAGES_DIR}/bin")
file(INSTALL "${SOURCE_PATH}/bin/livekit_ffi.dll" DESTINATION "${CURRENT_PACKAGES_DIR}/bin")

# Install CMake config - generate vcpkg-compatible configs instead of using SDK's
# (SDK's configs compute _IMPORT_PREFIX incorrectly for vcpkg's triplet layout)
file(WRITE "${CURRENT_PACKAGES_DIR}/share/LiveKit/LiveKitConfig.cmake"
[=[
include(CMakeFindDependencyMacro)
include("${CMAKE_CURRENT_LIST_DIR}/LiveKitTargets.cmake")
]=])

file(WRITE "${CURRENT_PACKAGES_DIR}/share/LiveKit/LiveKitTargets.cmake"
[=[
add_library(LiveKit::livekit SHARED IMPORTED)

get_filename_component(_LIVEKIT_PREFIX "${CMAKE_CURRENT_LIST_FILE}" PATH)
get_filename_component(_LIVEKIT_PREFIX "${_LIVEKIT_PREFIX}" PATH)
get_filename_component(_LIVEKIT_PREFIX "${_LIVEKIT_PREFIX}" PATH)

set_target_properties(LiveKit::livekit PROPERTIES
  INTERFACE_INCLUDE_DIRECTORIES "${_LIVEKIT_PREFIX}/include"
  IMPORTED_IMPLIB_RELEASE "${_LIVEKIT_PREFIX}/lib/livekit.lib"
  IMPORTED_LOCATION_RELEASE "${_LIVEKIT_PREFIX}/bin/livekit.dll"
  IMPORTED_CONFIGURATIONS RELEASE
)

# Also add livekit_ffi as imported
add_library(LiveKit::livekit_ffi SHARED IMPORTED)
set_target_properties(LiveKit::livekit_ffi PROPERTIES
  IMPORTED_IMPLIB_RELEASE "${_LIVEKIT_PREFIX}/lib/livekit_ffi.dll.lib"
  IMPORTED_LOCATION_RELEASE "${_LIVEKIT_PREFIX}/bin/livekit_ffi.dll"
  IMPORTED_CONFIGURATIONS RELEASE
)

set_target_properties(LiveKit::livekit PROPERTIES
  INTERFACE_LINK_LIBRARIES "LiveKit::livekit_ffi"
)

unset(_LIVEKIT_PREFIX)
]=])

# For debug, just copy release (SDK only ships release build)
file(INSTALL "${SOURCE_PATH}/lib/livekit.lib" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/lib")
file(INSTALL "${SOURCE_PATH}/lib/livekit_ffi.dll.lib" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/lib")
file(INSTALL "${SOURCE_PATH}/bin/livekit.dll" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/bin")
file(INSTALL "${SOURCE_PATH}/bin/livekit_ffi.dll" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/bin")

# Copyright
file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/copyright" "Apache-2.0. See https://github.com/livekit/client-sdk-cpp/blob/main/LICENSE")
