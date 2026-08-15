{
  Creates or reuses a patch plugin that hides female-playable HDPT records.

  Intended use:
  - Run on KS Hairdo's.esp or its Head Part group.
  - The source plugin is not edited.
  - Matching HDPT records are copied as overrides into PatchFileName.
  - The override keeps every flag except Playable.

  Result:
  - RaceMenu should stop listing these headparts.
  - Original records remain intact for references and extra parts.
}

unit UserScript;

const
  PatchFileName = 'KS Hairdos Male Only - Hide Female Playable HDPT.esp';
  LogFlagSamples = 12;
  HDPTFlagPlayable = 1;
  HDPTFlagFemale = 4;

var
  PatchFile: IInterface;
  TotalScanned: Integer;
  TotalMatched: Integer;
  TotalPatched: Integer;
  FlagSamplesLogged: Integer;
  SkipProcess: Boolean;

function FindFileByName(fileName: string): IInterface;
var
  i: Integer;
begin
  Result := nil;

  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), fileName) then begin
      Result := FileByIndex(i);
      Exit;
    end;
end;

function GetOverrideInPatch(rec: IInterface): IInterface;
var
  baseRec: IInterface;
  ovr: IInterface;
  i: Integer;
begin
  Result := nil;
  baseRec := MasterOrSelf(rec);

  for i := 0 to Pred(OverrideCount(baseRec)) do begin
    ovr := OverrideByIndex(baseRec, i);
    if SameText(GetFileName(GetFile(ovr)), GetFileName(PatchFile)) then begin
      Result := ovr;
      Exit;
    end;
  end;
end;

function GetHDPTFlags(rec: IInterface): string;
begin
  Result := GetElementEditValues(rec, 'DATA\Flags');

  if Result = '' then
    Result := GetElementEditValues(rec, 'DATA - Flags');
end;

function GetHDPTFlagsNative(rec: IInterface): Integer;
begin
  if Assigned(ElementByPath(rec, 'DATA\Flags')) then
    Result := GetElementNativeValues(rec, 'DATA\Flags')
  else
    Result := GetElementNativeValues(rec, 'DATA - Flags');
end;

procedure SetHDPTFlagsNative(rec: IInterface; flags: Integer);
begin
  if Assigned(ElementByPath(rec, 'DATA\Flags')) then
    SetElementNativeValues(rec, 'DATA\Flags', flags)
  else
    SetElementNativeValues(rec, 'DATA - Flags', flags);
end;

function EnsurePatchFile: Boolean;
begin
  Result := False;

  if Assigned(PatchFile) then begin
    Result := True;
    Exit;
  end;

  PatchFile := FindFileByName(PatchFileName);
  if not Assigned(PatchFile) then
    PatchFile := AddNewFileName(PatchFileName);

  if not Assigned(PatchFile) then begin
    AddMessage('Could not create or find patch plugin: ' + PatchFileName);
    Exit;
  end;

  AddMessage('Using patch plugin: ' + GetFileName(PatchFile));
  Result := True;
end;

procedure PatchRecord(rec: IInterface);
var
  patchRec: IInterface;
  flags: string;
  nativeFlags: Integer;
  newNativeFlags: Integer;
begin
  if Signature(rec) <> 'HDPT' then
    Exit;

  flags := GetHDPTFlags(rec);
  nativeFlags := GetHDPTFlagsNative(rec);

  if FlagSamplesLogged < LogFlagSamples then begin
    AddMessage('Sample HDPT flags: ' + Name(rec) + ' | edit "' + flags + '" | native ' + IntToStr(nativeFlags));
    Inc(FlagSamplesLogged);
  end;

  if (nativeFlags and HDPTFlagFemale) = 0 then
    Exit;

  if (nativeFlags and HDPTFlagPlayable) = 0 then
    Exit;

  Inc(TotalMatched);

  AddRequiredElementMasters(rec, PatchFile, False);

  patchRec := GetOverrideInPatch(rec);
  if not Assigned(patchRec) then
    patchRec := wbCopyElementToFile(rec, PatchFile, False, True);

  if not Assigned(patchRec) then begin
    AddMessage('Failed to copy override for: ' + Name(rec));
    Exit;
  end;

  newNativeFlags := nativeFlags and not HDPTFlagPlayable;
  SetHDPTFlagsNative(patchRec, newNativeFlags);

  Inc(TotalPatched);
  AddMessage('Patched: ' + Name(rec) + ' | native ' + IntToStr(nativeFlags) + ' -> ' + IntToStr(newNativeFlags));
end;

procedure ScanHDPTGroup(group: IInterface);
var
  i: Integer;
begin
  for i := 0 to Pred(ElementCount(group)) do begin
    Inc(TotalScanned);
    PatchRecord(ElementByIndex(group, i));
  end;
end;

function Initialize: Integer;
begin
  Result := 0;
  TotalScanned := 0;
  TotalMatched := 0;
  TotalPatched := 0;
  FlagSamplesLogged := 0;
  SkipProcess := False;

  try
    ScriptProcessElements := [etFile, etGroupRecord];
  except
    AddMessage('Could not set script to process selected files/groups.');
    SkipProcess := True;
    Result := 1;
    Exit;
  end;

  if MessageDlg(
    'This will create/update "' + PatchFileName + '" with overrides for every HDPT record that has both Female and Playable flags. The override removes Playable. Continue?',
    mtWarning,
    [mbYes, mbNo],
    0
  ) <> mrYes then begin
    SkipProcess := True;
    Result := 1;
  end;
end;

function Process(e: IInterface): Integer;
var
  group: IInterface;
  sourceFileName: string;
begin
  Result := 0;

  if SkipProcess then
    Exit;

  if not EnsurePatchFile then begin
    Result := 1;
    Exit;
  end;

  if ElementType(e) = etFile then begin
    sourceFileName := GetFileName(e);
    if SameText(sourceFileName, GetFileName(PatchFile)) then begin
      AddMessage('Skipping patch plugin selection: ' + GetFileName(PatchFile));
      Exit;
    end;

    AddMessage('Scanning file: ' + sourceFileName);
    group := GroupBySignature(e, 'HDPT');
    if Assigned(group) then
      ScanHDPTGroup(group)
    else
      AddMessage('No HDPT group found in: ' + GetFileName(e));

    Exit;
  end;

  if ElementType(e) = etGroupRecord then begin
    sourceFileName := GetFileName(GetFile(e));
    if SameText(sourceFileName, GetFileName(PatchFile)) then begin
      AddMessage('Skipping patch plugin group selection: ' + GetFileName(PatchFile));
      Exit;
    end;

    if (ElementCount(e) > 0) and (Signature(ElementByIndex(e, 0)) = 'HDPT') then begin
      AddMessage('Scanning selected HDPT group in: ' + sourceFileName);
      ScanHDPTGroup(e);
    end else
      AddMessage('Skipping non-HDPT group: ' + Name(e));

    Exit;
  end;
end;

function Finalize: Integer;
begin
  Result := 0;

  AddMessage('Done.');
  AddMessage('HDPT records scanned: ' + IntToStr(TotalScanned));
  AddMessage('Female + Playable records matched: ' + IntToStr(TotalMatched));
  AddMessage('Overrides patched: ' + IntToStr(TotalPatched));
  AddMessage('Make sure "' + PatchFileName + '" loads after the source hair plugin.');
end;

end.
