import { CreateProposalSchema, type CreateProposalInput, type ItemView } from '@barter/contracts';
import { Button, Input, Text, View } from '@tarojs/components';
import { useState } from 'react';
import { buttonRole, buttonDisabled, inputLabel, money } from './shared';

export function ProposalForm({ items, targetItemId, initial, side = 'INITIATOR', busy = false, onSubmit }: {
  items: ItemView[]; targetItemId: string; initial?: CreateProposalInput; side?: 'INITIATOR' | 'RECIPIENT'; busy?: boolean;
  onSubmit: (input: CreateProposalInput) => void | Promise<void>;
}) {
  const [offered, setOffered] = useState(initial?.offeredItemIds ?? []);
  const [target, setTarget] = useState(initial?.targetItemId ?? targetItemId);
  const [difference, setDifference] = useState(String(initial?.differenceFen ?? 0));
  const [payer, setPayer] = useState<'INITIATOR' | 'RECIPIENT'>(initial?.payer === 'RECIPIENT' ? 'RECIPIENT' : 'INITIATOR');
  const [delivery, setDelivery] = useState<'COURIER' | 'IN_PERSON'>(initial?.deliveryMode ?? 'IN_PERSON');
  const [shippingA, setShippingA] = useState(String(initial?.initiatorShippingFen ?? 0));
  const [shippingB, setShippingB] = useState(String(initial?.recipientShippingFen ?? 0));
  const integer = (value: string) => /^\d+$/.test(value) ? Number(value) : NaN;
  const input = { offeredItemIds: offered, targetItemId: target, differenceFen: integer(difference), payer: difference === '0' || integer(difference) === 0 ? 'NONE' as const : payer, deliveryMode: delivery, initiatorShippingFen: delivery === 'IN_PERSON' ? 0 : integer(shippingA), recipientShippingFen: delivery === 'IN_PERSON' ? 0 : integer(shippingB) };
  const parsed = CreateProposalSchema.safeParse(input);
  return <View>
    <Text>{side === 'INITIATOR' ? '选择自己的 1～5 件已上架物品' : '选择自己的 1 件目标物品'}</Text>
    {items.filter(item => item.status === 'ACTIVE').map(item => {
      const selected = side === 'INITIATOR' ? offered.includes(item.id) : target === item.id;
      return <View key={item.id}>
        <Button {...buttonRole} disabled={busy || (!selected && side === 'INITIATOR' && offered.length >= 5)} onClick={() => side === 'RECIPIENT' ? setTarget(item.id) : setOffered(selected ? offered.filter(id => id !== item.id) : [...offered, item.id])}>{selected ? '已选' : '选择'} {item.title}</Button>
        <Text>{money(item.referenceValueFen)}</Text>
      </View>;
    })}
    <Text>另一方物品保持不变；提交时重新验证物品是否可用。</Text>
    <Text>差价（分，0～20000）</Text>
    <Input {...inputLabel('差价（分）')} type='number' disabled={busy} value={difference} onInput={event => setDifference(event.detail.value)} />
    {integer(difference) > 0 && <View>
      <Text>付款方：{payer === 'INITIATOR' ? '发起方' : '接收方'}</Text>
      <Button {...buttonRole} disabled={busy} onClick={() => setPayer('INITIATOR')}>发起方补差</Button>
      <Button {...buttonRole} disabled={busy} onClick={() => setPayer('RECIPIENT')}>接收方补差</Button>
    </View>}
    <Text>配送方式：{delivery === 'IN_PERSON' ? '面交' : '快递'}</Text>
    <Button {...buttonRole} disabled={busy} onClick={() => setDelivery('IN_PERSON')}>选择面交</Button>
    <Button {...buttonRole} disabled={busy} onClick={() => setDelivery('COURIER')}>选择快递</Button>
    {delivery === 'COURIER' && <View>
      <Text>双方各自承担的运费估计（分）</Text>
      <Text>发起方运费（分）</Text>
      <Input {...inputLabel('发起方运费（分）')} type='number' disabled={busy} value={shippingA} onInput={event => setShippingA(event.detail.value)} />
      <Text>接收方运费（分）</Text>
      <Input {...inputLabel('接收方运费（分）')} type='number' disabled={busy} value={shippingB} onInput={event => setShippingB(event.detail.value)} />
    </View>}
    <Button {...buttonRole} {...buttonDisabled(busy || !parsed.success)} disabled={busy || !parsed.success} onClick={() => { if (!busy && parsed.success) void onSubmit(parsed.data); }}>提交方案</Button>
  </View>;
}
