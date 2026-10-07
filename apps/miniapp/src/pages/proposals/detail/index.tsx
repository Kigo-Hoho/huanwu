import type { CounterProposalInput, CreateProposalInput, ItemView, ProposalCommandInput, ProposalView, Role } from '@barter/contracts';
import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { IdentityCodeProvider } from '../../../features/auth/identity-code.provider';
import { ApiClientError } from '../../../lib/api-client';
import { createSubmitCommandKey, defaultApiClient, defaultIdentityProvider, defaultOrderApi } from '../../../lib/default-services';
import type { OrderApi } from '../../../features/orders/order-api';
import { ProposalForm } from '../proposal-form';
import { alertRole, buttonRole, errorText, ProposalHistory } from '../shared';

interface ProposalApi {
  authenticate(provider: IdentityCodeProvider): Promise<void>;
  getMe(): Promise<{ id: string; roles?: Role[] }>;
  getProposal(id: string): Promise<ProposalView>;
  listMyItems(): Promise<ItemView[]>;
  commandProposal(id: string, action: 'counter' | 'accept' | 'reject' | 'cancel', input: CounterProposalInput | ProposalCommandInput, key: string): Promise<ProposalView>;
}
export function ProposalDetailPage({ api = defaultApiClient, orderApi = defaultOrderApi, proposalId = Taro.getCurrentInstance().router?.params.id ?? '' }: { api?: ProposalApi; orderApi?: Pick<OrderApi, 'convertProposal'> & Partial<Pick<OrderApi, 'onIdentityInvalidated'>>; proposalId?: string }) {
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [actor, setActor] = useState('');
  const [customer, setCustomer] = useState(false);
  const conversion = useRef<{ id: string; expectedVersion: number } | null>(null);
  const [conversionUnknown, setConversionUnknown] = useState(false);
  const [items, setItems] = useState<ItemView[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const locked = useRef(false);
  const readGeneration = useRef(0);
  const lifecycle = useRef(0);
  const resource = useRef(proposalId);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => orderApi.onIdentityInvalidated?.(() => {
    lifecycle.current += 1; readGeneration.current += 1; conversion.current = null; attempt.current = null;
    locked.current = false; setBusy(false); setConversionUnknown(false); setCustomer(false); setActor('');
    setProposal(null); setItems([]); setEditing(false); setError('登录身份已变化或无法核实，请刷新方案并重新确认建单。');
  }), [orderApi]);
  useEffect(() => {
    if (resource.current !== proposalId) {
      resource.current = proposalId; conversion.current = null; setConversionUnknown(false); locked.current = false; setBusy(false); setProposal(null);
    }
    if (locked.current) return;
    lifecycle.current += 1;
    let active = true;
    const generation = ++readGeneration.current;
    void (async () => {
      await api.authenticate(defaultIdentityProvider);
      const [me, detail, owned] = await Promise.all([api.getMe(), api.getProposal(proposalId), api.listMyItems()]);
      if (active && generation === readGeneration.current) { setActor(me.id); setCustomer(me.roles?.length === 1 && me.roles[0] === 'CUSTOMER'); setProposal(old => old?.id === detail.id && old.version > detail.version ? old : detail); setItems(owned); }
    })().catch(cause => { if (active && generation === readGeneration.current) setError(errorText(cause)); });
    return () => { active = false; lifecycle.current += 1; };
  }, [api, proposalId, refresh]);
  const run = async (action: 'counter' | 'accept' | 'reject' | 'cancel', offer?: CreateProposalInput) => {
    if (!proposal || locked.current) return;
    // A read started before this command must never overwrite its result or error.
    readGeneration.current += 1;
    locked.current = true; setBusy(true); setError('');
    const commandLife = lifecycle.current;
    const input = { ...offer, expectedVersion: proposal.version };
    const body = JSON.stringify({ id: proposal.id, action, input });
    if (attempt.current?.body !== body) attempt.current = { body, key: createSubmitCommandKey() };
    try {
      const result = await api.commandProposal(proposal.id, action, input, attempt.current!.key);
      if (commandLife !== lifecycle.current) return;
      setProposal(result); setEditing(false); attempt.current = null;
    } catch (cause) {
      if (commandLife !== lifecycle.current) return;
      setError(errorText(cause));
      if (cause instanceof ApiClientError && cause.statusCode < 500) {
        attempt.current = null;
        if (cause.statusCode === 409 || cause.statusCode === 403) {
          setEditing(false);
          try { setProposal(await api.getProposal(proposal.id)); } catch { setProposal(null); }
        }
      }
    } finally { if (commandLife === lifecycle.current) { locked.current = false; setBusy(false); } }
  };
  const current = proposal?.versions.find(version => version.number === proposal.currentVersion);
  const convert = async () => {
    if (!proposal || locked.current || !customer) return;
    locked.current = true; setBusy(true); readGeneration.current += 1; setError('');
    const commandLife = lifecycle.current;
    const original = conversion.current ?? { id: proposal.id, expectedVersion: proposal.version }; conversion.current = original;
    try {
      const result = await orderApi.convertProposal(original.id, { expectedVersion: original.expectedVersion });
      if (commandLife !== lifecycle.current || original.id !== resource.current) return;
      conversion.current = null; setConversionUnknown(false);
      setProposal(old => old?.id === original.id ? { ...old, status: 'CONVERTED', orderId: result.order.id } : old);
      try { const latest = await api.getProposal(original.id); if (commandLife === lifecycle.current) setProposal(old => old?.id !== original.id ? old : old.version > latest.version ? old : latest.status === 'CONVERTED' ? latest : { ...latest, status: 'CONVERTED', orderId: result.order.id }); } catch { /* The successful order entry remains available. */ }
    } catch (cause) {
      if (commandLife !== lifecycle.current || original.id !== resource.current) return;
      if (cause instanceof ApiClientError && cause.statusCode < 500) {
        conversion.current = null; setConversionUnknown(false);
        if (cause.statusCode === 403 || cause.statusCode === 409) {
          setCustomer(false);
          try { const [latest, me] = await Promise.all([api.getProposal(original.id), api.getMe()]); if (commandLife === lifecycle.current) { setProposal(latest); setActor(me.id); setCustomer(me.roles?.length === 1 && me.roles[0] === 'CUSTOMER'); } } catch { if (commandLife === lifecycle.current) setProposal(null); }
          if (commandLife === lifecycle.current) setError('方案已更新，请核对后重新确认建单');
        } else setError('建单未获批准，请刷新方案核对。');
      } else { setConversionUnknown(true); setError('建单结果未明，请重试原建单操作。'); }
    } finally { if (commandLife === lifecycle.current) { locked.current = false; setBusy(false); } }
  };
  const participant = proposal && [proposal.initiatorId, proposal.recipientId].includes(actor);
  const responder = participant && proposal.status === 'PENDING' && proposal.responderId === actor;
  const initial = current && { offeredItemIds: current.offeredItems.map(item => item.itemId), targetItemId: current.targetItem.itemId, differenceFen: current.differenceFen, payer: current.payer, deliveryMode: current.deliveryMode, initiatorShippingFen: current.initiatorShippingFen, recipientShippingFen: current.recipientShippingFen };
  return <View>
    <Text>交换方案</Text>
    <Button {...buttonRole} disabled={busy} onClick={() => { if (!locked.current) setRefresh(value => value + 1); }}>刷新方案</Button>
    {error && <Text {...alertRole}>{error}</Text>}
    {!proposal ? <Text>加载方案中</Text> : <View>
      <ProposalHistory proposal={proposal} />
      {participant && customer && proposal.status === 'CONFIRMED' && !conversionUnknown && <Button {...buttonRole} disabled={busy} onClick={() => { void convert(); }}>生成交换订单</Button>}
      {participant && customer && conversionUnknown && <Button {...buttonRole} disabled={busy} onClick={() => { void convert(); }}>重试原建单操作</Button>}
      {participant && proposal.status === 'CONVERTED' && proposal.orderId && <Button {...buttonRole} onClick={() => { void Taro.navigateTo({ url: `/pages/orders/detail/index?id=${encodeURIComponent(proposal.orderId!)}` }); }}>查看交换订单</Button>}
      {responder ? <View>
        <Text>轮到你回应</Text>
        <Button {...buttonRole} disabled={busy} onClick={() => { void run('accept'); }}>接受方案</Button>
        <Button {...buttonRole} disabled={busy} onClick={() => { void run('reject'); }}>拒绝方案</Button>
        <Button {...buttonRole} disabled={busy} onClick={() => setEditing(value => !value)}>修改方案</Button>
        {editing && initial && <ProposalForm key={proposal.version} initial={initial} targetItemId={initial.targetItemId} items={items} side={actor === proposal.initiatorId ? 'INITIATOR' : 'RECIPIENT'} busy={busy} onSubmit={offer => run('counter', offer)} />}
      </View> : proposal.status === 'PENDING' && <Text>等待对方回应</Text>}
      {participant && !conversionUnknown && ['PENDING', 'CONFIRMED'].includes(proposal.status) && <Button {...buttonRole} disabled={busy} onClick={() => { void run('cancel'); }}>取消提案</Button>}
    </View>}
  </View>;
}
export default ProposalDetailPage;
