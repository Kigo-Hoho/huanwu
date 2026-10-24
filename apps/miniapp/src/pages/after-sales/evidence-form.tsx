import { Button, Input, Text, View } from '@tarojs/components';
import { useState } from 'react';
import type { CaseDetailView } from '@barter/contracts';
import { alertRole, buttonDisabled, buttonRole, inputLabel } from '../orders/shared';

export function EvidenceForm({
  detail, orderVersion, busy, onAppend, chooseImages,
}: {
  detail: CaseDetailView;
  orderVersion: number;
  busy: boolean;
  onAppend: (input: { expectedCaseVersion: number; expectedOrderVersion: number; description: string }, files: string[]) => Promise<unknown>;
  chooseImages: () => Promise<string[]>;
}) {
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState('');
  const can = description.trim().length > 0 && files.length > 0 && files.length <= 9 && !busy;
  return <View>
    <Text>补充证据</Text>
    <Input {...inputLabel('证据说明')} value={description} disabled={busy} onInput={e => setDescription(e.detail.value)} />
    <Button {...buttonRole} disabled={busy} onClick={() => { void chooseImages().then(setFiles).catch(() => setError('选图失败')); }}>选择图片（{files.length}/9）</Button>
    {error && <Text {...alertRole}>{error}</Text>}
    <Button {...buttonRole} {...buttonDisabled(!can)} disabled={!can} onClick={() => {
      if (!can) return;
      setError('');
      void onAppend({ expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, description: description.trim() }, files)
        .then(() => { setDescription(''); setFiles([]); })
        .catch(() => setError('证据上传失败，请核对后重试。'));
    }}>上传证据</Button>
  </View>;
}
