#include "Validators.h"

bool ValidateFilename(std::string_view filename, bool allowDots)
{
  for (char c : filename) {
    // Plugin filenames from real Skyrim load orders may contain spaces and
    // simple punctuation, e.g. "Water for ENB (Vanilla).esp". Keep this
    // filename-only: do not allow path separators, drive separators, quotes,
    // wildcards, or traversal-related characters here.
    if (!(('0' <= c && c <= '9') || ('A' <= c && c <= 'Z') ||
          ('a' <= c && c <= 'z') || (c == '.' && allowDots) || c == '-' ||
          c == '_' || c == ' ' || c == '(' || c == ')' || c == '[' ||
          c == ']' || c == '+' || c == '\'' || c == '&' || c == ',')) {
      return false;
    }
  }
  return true;
}

bool ValidateRelativePath(std::string_view path)
{
  for (size_t i = 0; i < path.size(); ++i) {
    // Forbid everything including ':' and null character
    const char& c = path[i];
    if (!(('0' <= c && c <= '9') || ('A' <= c && c <= 'Z') ||
          ('a' <= c && c <= 'z') || c == '.' || c == '-' || c == '_' ||
          c == '/' || c == '\\')) {
      return false;
    }
    if (i > 0 && path[i - 1] == '.' && path[i] == '.') {
      return false;
    }
  }
  return true;
}
