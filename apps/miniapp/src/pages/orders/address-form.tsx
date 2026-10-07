import { OrderAddressSchema, type OrderAddressInput } from '@barter/contracts';
import { Button, Input, Text, View } from '@tarojs/components';
import { useState } from 'react';
import { alertRole, buttonRole, buttonDisabled, inputLabel } from './shared';

export function AddressForm({ version, busy, onSave }: { version: number; busy: boolean; onSave: (input: OrderAddressInput) => Promise<void> }) {
  const [fields, setFields] = useState({ recipientName: '', phone: '', region: '', detail: '' });
  const [error, setError] = useState('');
  const parsed = OrderAddressSchema.safeParse({ ...fields, expectedVersion: version });
  return <View>
    <Text>仅填写我自己的收货资料</Text>
    {(['recipientName', 'phone', 'region', 'detail'] as const).map((name, index) => {
      const label = ['收件人', '电话', '地区', '详细地址'][index]!;
      return <View key={name}><Text>{label}</Text><Input {...inputLabel(label)} value={fields[name]} disabled={busy} onInput={event => { setFields(current => ({ ...current, [name]: event.detail.value })); }} /></View>;
    })}
    {error && <Text {...alertRole}>{error}</Text>}
    <Button {...buttonRole} {...buttonDisabled(busy || !parsed.success)} disabled={busy || !parsed.success} onClick={() => {
      if (busy || !parsed.success) return;
      setError(''); void onSave(parsed.data).then(() => { setFields({ recipientName: '', phone: '', region: '', detail: '' }); }).catch(() => { setError('资料提交未确认，请核对订单提示。'); });
    }}>保存我的收货资料</Button>
  </View>;
}
