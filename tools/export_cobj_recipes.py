from __future__ import annotations

import argparse
import html
import re
import struct
import zlib
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable


RECORD_HEADER_SIZE = 24
COMPRESSED_RECORD_FLAG = 0x00040000


@dataclass
class RecordInfo:
    plugin: str
    record_type: str
    form_id: int
    local_id: int
    runtime_id: int | None = None
    editor_id: str | None = None
    full_name: str | None = None


@dataclass
class CobjRecord:
    plugin: str
    form_id: int
    local_id: int
    runtime_id: int | None = None
    editor_id: str | None = None
    conditions: list[bytes] = field(default_factory=list)
    output_object: int | None = None
    output_count: int | None = None
    bench_keyword: int | None = None
    inputs: list[tuple[int, int]] = field(default_factory=list)


@dataclass
class PluginData:
    path: Path
    name: str
    is_light: bool = False
    masters: list[str] = field(default_factory=list)
    records: list[RecordInfo] = field(default_factory=list)
    cobjs: list[CobjRecord] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def u16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def f32(data: bytes, offset: int) -> float:
    return struct.unpack_from("<f", data, offset)[0]


def zstring(data: bytes) -> str:
    raw = data.split(b"\x00", 1)[0]
    for encoding in ("utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding, errors="replace")
        except UnicodeDecodeError:
            pass
    return raw.decode("latin-1", errors="replace")


def iter_fields(data: bytes) -> Iterable[tuple[str, bytes]]:
    offset = 0
    extended_size: int | None = None
    while offset + 6 <= len(data):
        field_type = data[offset : offset + 4].decode("ascii", errors="replace")
        size = u16(data, offset + 4)
        offset += 6

        if field_type == "XXXX" and offset + 4 <= len(data):
            extended_size = u32(data, offset)
            offset += size
            continue

        if extended_size is not None:
            size = extended_size
            extended_size = None

        payload = data[offset : offset + size]
        offset += size
        yield field_type, payload


def decompress_record(payload: bytes) -> bytes:
    if len(payload) < 4:
        return payload
    expected_size = u32(payload, 0)
    result = zlib.decompress(payload[4:])
    if expected_size and len(result) != expected_size:
        # Keep the data anyway; some tools are liberal around this value.
        return result
    return result


def parse_condition_functions(repo_root: Path) -> dict[int, str]:
    result: dict[int, str] = {}
    condition_dir = repo_root / "skymp5-server" / "cpp" / "server_guest_lib" / "condition_functions"
    if not condition_dir.exists():
        return result

    for cpp in condition_dir.glob("*.cpp"):
        text = cpp.read_text(encoding="utf-8", errors="ignore")
        name_match = re.search(r'return\s+"([^"]+)"\s*;', text)
        index_match = re.search(r"GetFunctionIndex\([^)]*\)\s*(?:const\s*)?\{[^{}]*?return\s+(\d+)\s*;", text, re.S)
        if name_match and index_match:
            result[int(index_match.group(1))] = name_match.group(1)
    return result


def operator_from_flag(operator_flag: int) -> str:
    value = (4 if operator_flag & 0x80 else 0) + (2 if operator_flag & 0x40 else 0) + (1 if operator_flag & 0x20 else 0)
    return {
        0: "==",
        1: "!=",
        2: ">",
        3: ">=",
        4: "<",
        5: "<=",
    }.get(value, f"op{value}")


def format_form_id(value: int | None) -> str:
    if value is None:
        return ""
    return f"0x{value:08X}"


def runtime_form_id(plugin: PluginData, local_form_id: int, slot_map: dict[str, tuple[str, int]]) -> int | None:
    slot = slot_map.get(plugin.name.lower())
    if not slot:
        return None
    kind, index = slot
    if kind == "light":
        return 0xFE000000 | ((index & 0xFFF) << 12) | (local_form_id & 0xFFF)
    return ((index & 0xFF) << 24) | (local_form_id & 0x00FFFFFF)


def read_list_file(path: Path, enabled_only: bool) -> list[str]:
    if not path.exists():
        return []
    result: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if enabled_only and not line.startswith("*"):
            continue
        if line.startswith("*"):
            line = line[1:].strip()
        if line:
            result.append(line)
    return result


def get_appdata_list_candidates(file_name: str) -> list[Path]:
    import os

    local_appdata = os.environ.get("LOCALAPPDATA")
    if not local_appdata:
        return []
    return [
        Path(local_appdata) / "Skyrim Special Edition" / file_name,
        Path(local_appdata) / "Skyrim Special Edition GOG" / file_name,
        Path(local_appdata) / "Skyrim VR" / file_name,
    ]


def read_first_appdata_list(file_name: str, enabled_only: bool) -> list[str]:
    for path in get_appdata_list_candidates(file_name):
        entries = read_list_file(path, enabled_only)
        if entries:
            return entries
    return []


def build_load_order(plugin_by_name: dict[str, PluginData]) -> list[str]:
    enabled = read_first_appdata_list("plugins.txt", True)
    loadorder = read_first_appdata_list("loadorder.txt", False)
    seen: set[str] = set()
    result: list[str] = []

    def push(name: str) -> None:
        key = name.lower()
        if key in seen:
            return
        if key not in plugin_by_name:
            return
        seen.add(key)
        result.append(plugin_by_name[key].name)

    if loadorder:
        enabled_names = {name.lower() for name in enabled}
        for name in loadorder:
            key = name.lower()
            if key in enabled_names or key in plugin_by_name:
                push(name)
        for name in enabled:
            push(name)
    elif enabled:
        for name in enabled:
            push(name)
    else:
        for name in sorted(plugin_by_name):
            push(plugin_by_name[name].name)

    return result


def build_slot_map(load_order: list[str], plugin_by_name: dict[str, PluginData]) -> dict[str, tuple[str, int]]:
    slot_map: dict[str, tuple[str, int]] = {}
    full_index = 0
    light_index = 0
    for name in load_order:
        plugin = plugin_by_name.get(name.lower())
        if not plugin:
            continue
        if plugin.is_light:
            slot_map[plugin.name.lower()] = ("light", light_index)
            light_index += 1
        else:
            slot_map[plugin.name.lower()] = ("full", full_index)
            full_index += 1
    return slot_map


def resolve_local_form(plugin: PluginData, local_form_id: int, record_index: dict[tuple[str, int], RecordInfo]) -> RecordInfo | None:
    file_index = (local_form_id >> 24) & 0xFF
    object_id = local_form_id & 0x00FFFFFF
    target_plugin = plugin.masters[file_index] if file_index < len(plugin.masters) else plugin.name
    return record_index.get((target_plugin.lower(), object_id))


def describe_ref(plugin: PluginData, local_form_id: int | None, record_index: dict[tuple[str, int], RecordInfo]) -> str:
    if not local_form_id:
        return ""
    resolved = resolve_local_form(plugin, local_form_id, record_index)
    if not resolved:
        return format_form_id(local_form_id)

    id_text = format_form_id(resolved.runtime_id) if resolved.runtime_id is not None else format_form_id(local_form_id)
    label_parts = [id_text, resolved.record_type]
    if resolved.editor_id:
        label_parts.append(resolved.editor_id)
    if resolved.full_name:
        label_parts.append(f'"{resolved.full_name}"')
    label_parts.append(f"[{resolved.plugin}]")
    return " ".join(label_parts)


def describe_conditions(
    plugin: PluginData,
    conditions: list[bytes],
    record_index: dict[tuple[str, int], RecordInfo],
    function_names: dict[int, str],
) -> str:
    if not conditions:
        return ""

    parts: list[str] = []
    for idx, ctda in enumerate(conditions, start=1):
        if len(ctda) < 32:
            parts.append(f"{idx}. <short CTDA {len(ctda)} bytes>")
            continue

        operator_flag = ctda[0]
        logical = "OR" if operator_flag & 0x01 else "AND"
        flags: list[str] = []
        if operator_flag & 0x02:
            flags.append("Parameters")
        if operator_flag & 0x04:
            flags.append("UseGlobal")
        if operator_flag & 0x08:
            flags.append("UsePackData")
        if operator_flag & 0x10:
            flags.append("SwapSubject")

        comparison = f32(ctda, 4)
        function_index = u16(ctda, 8)
        function_name = function_names.get(function_index, f"Function#{function_index}")
        param1 = u32(ctda, 12)
        param2 = u32(ctda, 16)
        run_on = u32(ctda, 20)
        reference = u32(ctda, 24)

        param1_text = describe_ref(plugin, param1, record_index) if param1 else "0"
        param2_text = describe_ref(plugin, param2, record_index) if param2 else "0"
        ref_text = describe_ref(plugin, reference, record_index) if reference else "0"
        flag_text = f" flags={'+'.join(flags)}" if flags else ""

        parts.append(
            f"{idx}. {logical} {function_name}({param1_text}, {param2_text}) "
            f"{operator_from_flag(operator_flag)} {comparison:g}; runOn={run_on}; ref={ref_text}{flag_text}"
        )
    return "\n".join(parts)


def parse_record_fields(
    plugin: PluginData,
    record_type: str,
    form_id: int,
    payload: bytes,
    slot_map: dict[str, tuple[str, int]] | None = None,
) -> None:
    editor_id: str | None = None
    full_name: str | None = None
    runtime_id = runtime_form_id(plugin, form_id, slot_map or {})
    cobj = CobjRecord(
        plugin=plugin.name,
        form_id=form_id,
        local_id=form_id & 0x00FFFFFF,
        runtime_id=runtime_id,
    ) if record_type == "COBJ" else None

    for field_type, data in iter_fields(payload):
        if field_type == "EDID":
            editor_id = zstring(data)
            if cobj:
                cobj.editor_id = editor_id
        elif field_type == "FULL":
            if len(data) == 4:
                full_name = f"localized:{u32(data, 0):08X}"
            else:
                full_name = zstring(data)
        elif cobj and field_type == "CTDA":
            cobj.conditions.append(data)
        elif cobj and field_type == "CNAM" and len(data) >= 4:
            cobj.output_object = u32(data, 0)
        elif cobj and field_type == "NAM1" and len(data) >= 2:
            cobj.output_count = u16(data, 0)
        elif cobj and field_type == "BNAM" and len(data) >= 4:
            cobj.bench_keyword = u32(data, 0)
        elif cobj and field_type == "CNTO" and len(data) >= 8:
            cobj.inputs.append((u32(data, 0), u32(data, 4)))

    plugin.records.append(
        RecordInfo(
            plugin=plugin.name,
            record_type=record_type,
            form_id=form_id,
            local_id=form_id & 0x00FFFFFF,
            runtime_id=runtime_id,
            editor_id=editor_id,
            full_name=full_name,
        )
    )
    if cobj:
        plugin.cobjs.append(cobj)


def parse_tes4(plugin: PluginData, payload: bytes) -> None:
    for field_type, data in iter_fields(payload):
        if field_type == "MAST":
            master = zstring(data)
            if master:
                plugin.masters.append(master)


def parse_records(
    plugin: PluginData,
    data: bytes,
    start: int,
    end: int,
    slot_map: dict[str, tuple[str, int]] | None = None,
) -> None:
    offset = start
    while offset + RECORD_HEADER_SIZE <= end:
        record_type = data[offset : offset + 4].decode("ascii", errors="replace")
        size = u32(data, offset + 4)

        if record_type == "GRUP":
            group_end = offset + size
            if size < RECORD_HEADER_SIZE or group_end > end:
                plugin.errors.append(f"Invalid GRUP at 0x{offset:X}, size {size}")
                return
            parse_records(plugin, data, offset + RECORD_HEADER_SIZE, group_end, slot_map)
            offset = group_end
            continue

        record_end = offset + RECORD_HEADER_SIZE + size
        if record_end > end:
            plugin.errors.append(f"Invalid {record_type} at 0x{offset:X}, size {size}")
            return

        flags = u32(data, offset + 8)
        form_id = u32(data, offset + 12)
        payload = data[offset + RECORD_HEADER_SIZE : record_end]

        try:
            if flags & COMPRESSED_RECORD_FLAG:
                payload = decompress_record(payload)
            if record_type == "TES4":
                plugin.is_light = plugin.is_light or bool(flags & 0x00000200)
                parse_tes4(plugin, payload)
            else:
                parse_record_fields(plugin, record_type, form_id, payload, slot_map)
        except Exception as exc:
            plugin.errors.append(f"{record_type} {form_id:08X}: {exc}")

        offset = record_end


def parse_plugin(path: Path, slot_map: dict[str, tuple[str, int]] | None = None) -> PluginData:
    plugin = PluginData(path=path, name=path.name)
    if path.suffix.lower() == ".esl":
        plugin.is_light = True
    data = path.read_bytes()
    parse_records(plugin, data, 0, len(data), slot_map)
    return plugin


def column_letter(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def inline_cell(value: object, row: int, col: int) -> str:
    ref = f"{column_letter(col)}{row}"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"><v>{value}</v></c>'
    text = "" if value is None else str(value)
    return f'<c r="{ref}" t="inlineStr"><is><t>{html.escape(text)}</t></is></c>'


def worksheet_xml(rows: list[list[object]]) -> str:
    row_xml: list[str] = []
    for row_idx, row in enumerate(rows, start=1):
        cells = "".join(inline_cell(value, row_idx, col_idx) for col_idx, value in enumerate(row, start=1))
        row_xml.append(f'<row r="{row_idx}">{cells}</row>')
    last_col = column_letter(len(rows[0])) if rows else "A"
    last_row = len(rows)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<dimension ref="A1:{last_col}{last_row}"/>'
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        '<cols>'
        '<col min="1" max="1" width="34" customWidth="1"/>'
        '<col min="2" max="2" width="14" customWidth="1"/>'
        '<col min="3" max="3" width="34" customWidth="1"/>'
        '<col min="4" max="4" width="80" customWidth="1"/>'
        '<col min="5" max="5" width="20" customWidth="1"/>'
        '<col min="6" max="6" width="90" customWidth="1"/>'
        '<col min="7" max="11" width="18" customWidth="1"/>'
        '</cols>'
        f'<sheetData>{"".join(row_xml)}</sheetData>'
        f'<autoFilter ref="A1:{last_col}{last_row}"/>'
        '</worksheet>'
    )


def write_xlsx(path: Path, rows: list[list[object]]) -> None:
    sheet = worksheet_xml(rows)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""")
        z.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>""")
        z.writestr("xl/workbook.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="COBJ Recipes" sheetId="1" r:id="rId1"/></sheets>
</workbook>""")
        z.writestr("xl/_rels/workbook.xml.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>""")
        z.writestr("xl/worksheets/sheet1.xml", sheet)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repo-root", default=Path.cwd(), type=Path)
    parser.add_argument("--include-esm", action="store_true")
    args = parser.parse_args()

    parse_suffixes = {".esp", ".esl", ".esm"}
    export_suffixes = {".esp", ".esl"}
    if args.include_esm:
        export_suffixes.add(".esm")

    plugin_paths = sorted(
        [p for p in args.data_dir.iterdir() if p.is_file() and p.suffix.lower() in parse_suffixes],
        key=lambda p: p.name.lower(),
    )

    plugins = [parse_plugin(path) for path in plugin_paths]
    plugin_by_name = {plugin.name.lower(): plugin for plugin in plugins}
    load_order = build_load_order(plugin_by_name)
    slot_map = build_slot_map(load_order, plugin_by_name)

    for plugin in plugins:
        for record in plugin.records:
            record.runtime_id = runtime_form_id(plugin, record.form_id, slot_map)
        for cobj in plugin.cobjs:
            cobj.runtime_id = runtime_form_id(plugin, cobj.form_id, slot_map)

    record_index: dict[tuple[str, int], RecordInfo] = {}
    for plugin in plugins:
        for record in plugin.records:
            record_index[(plugin.name.lower(), record.local_id)] = record

    function_names = parse_condition_functions(args.repo_root)

    rows: list[list[object]] = [
        [
            "Plugin",
            "Runtime FormID",
            "Local FormID",
            "EditorID",
            "Conditions",
            "Output Count",
            "What object gets crafted",
            "Output Local FormID",
            "Workbench Keyword",
            "Inputs",
            "Slot",
            "Master Count",
            "Parse Errors",
        ]
    ]

    for plugin in plugins:
        if plugin.path.suffix.lower() not in export_suffixes:
            continue
        error_text = "\n".join(plugin.errors)
        slot = slot_map.get(plugin.name.lower())
        slot_text = f"{slot[0]} 0x{slot[1]:X}" if slot else ""
        for cobj in plugin.cobjs:
            crafted = describe_ref(plugin, cobj.output_object, record_index)
            output_form = format_form_id(cobj.output_object)
            workbench = describe_ref(plugin, cobj.bench_keyword, record_index)
            inputs = "\n".join(
                f"{count} x {describe_ref(plugin, form_id, record_index)}"
                for form_id, count in cobj.inputs
            )
            rows.append(
                [
                    plugin.name,
                    format_form_id(cobj.runtime_id),
                    format_form_id(cobj.form_id),
                    cobj.editor_id or "",
                    describe_conditions(plugin, cobj.conditions, record_index, function_names),
                    cobj.output_count or "",
                    crafted,
                    output_form,
                    workbench,
                    inputs,
                    slot_text,
                    len(plugin.masters),
                    error_text,
                ]
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_xlsx(args.output, rows)
    print(f"Parsed {len(plugin_paths)} plugins for resolution")
    print(f"Load order entries resolved: {len(load_order)}")
    print(f"Exported {len(rows) - 1} COBJ records")
    print(args.output)


if __name__ == "__main__":
    main()
