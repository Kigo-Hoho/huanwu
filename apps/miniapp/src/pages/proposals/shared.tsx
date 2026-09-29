import type { ProposalView } from '@barter/contracts';
import { Button, Image, Input, Text, View } from '@tarojs/components';
import type { ComponentProps } from 'react';

export const buttonRole = { role: 'button' } as unknown as ComponentProps<typeof Button>;
export const buttonDisabled = (disabled: boolean) => ({ 'aria-disabled': disabled } as unknown as ComponentProps<typeof Button>);
export const alertRole = { role: 'alert' } as unknown as ComponentProps<typeof Text>;
export const inputLabel = (label: string) => ({ 'aria-label': label } as unknown as ComponentProps<typeof Input>);
export const statusLabels = { PENDING: '待回应', CONFIRMED: '已确认', REJECTED: '已拒绝', CANCELLED: '已取消', EXPIRED: '已到期' };
export const money = (fen: number) => `￥${(fen / 100).toFixed(2)}`;
export const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '请求失败，请重试';

export function ProposalHistory({ proposal }: { proposal: ProposalView }) {
  return <View>
    <Text>{statusLabels[proposal.status]}</Text>
    <Text>待回应期限：{proposal.expiresAt}</Text>
    {proposal.reservationExpiresAt && <Text>占用期限：{proposal.reservationExpiresAt}</Text>}
    <Text>接受后仅占用物品 72 小时，不产生订单或支付。</Text>
    {proposal.versions.map(version => <View key={version.id}>
      <Text>方案历史 · 第 {version.number} 版</Text>
      <Text>出价时间：{version.createdAt}</Text>
      {[...version.offeredItems, version.targetItem].map(item => <View key={item.itemId}>
        <Text>{item.ownerId === proposal.initiatorId ? '发起方' : '接收方'}：{item.title}</Text>
        <Text>{item.description}</Text><Text>参考价值：{money(item.referenceValueFen)}</Text>
        <Text>成色：{item.condition} · 想换：{item.wantedText}</Text>
        {item.imageUrls.map(url => <Image key={url} src={url} mode='aspectFit' style={{ width: '120px', height: '90px' }} />)}
      </View>)}
      <Text>差价：{money(version.differenceFen)} · {version.payer === 'NONE' ? '无需补差' : version.payer === 'INITIATOR' ? '发起方补差' : '接收方补差'}</Text>
      <Text>{version.deliveryMode === 'COURIER' ? '快递' : '面交'} · 发起方运费估计 {money(version.initiatorShippingFen)} · 接收方运费估计 {money(version.recipientShippingFen)}</Text>
    </View>)}
  </View>;
}
