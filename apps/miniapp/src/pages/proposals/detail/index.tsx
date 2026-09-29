import type { CounterProposalInput, CreateProposalInput, ItemView, ProposalCommandInput, ProposalView } from '@barter/contracts';
import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { IdentityCodeProvider } from '../../../features/auth/identity-code.provider';
import { ApiClientError } from '../../../lib/api-client';
import { createSubmitCommandKey, defaultApiClient, defaultIdentityProvider } from '../../../lib/default-services';
import { ProposalForm } from '../proposal-form';
import { alertRole, buttonRole, errorText, ProposalHistory } from '../shared';

interface ProposalApi {
  authenticate(provider: IdentityCodeProvider): Promise<void>;
  getMe(): Promise<{ id: string }>;
  getProposal(id: string): Promise<ProposalView>;
  listMyItems(): Promise<ItemView[]>;
  commandProposal(id: string, action: 'counter' | 'accept' | 'reject' | 'cancel', input: CounterProposalInput | ProposalCommandInput, key: string): Promise<ProposalView>;
}
export function ProposalDetailPage({ api = defaultApiClient, proposalId = Taro.getCurrentInstance().router?.params.id ?? '' }: { api?: ProposalApi; proposalId?: string }) {
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [actor, setActor] = useState('');
  const [items, setItems] = useState<ItemView[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const locked = useRef(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      await api.authenticate(defaultIdentityProvider);
      const [me, detail, owned] = await Promise.all([api.getMe(), api.getProposal(proposalId), api.listMyItems()]);
      if (active) { setActor(me.id); setProposal(detail); setItems(owned); }
    })().catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [api, proposalId, refresh]);
  const run = async (action: 'counter' | 'accept' | 'reject' | 'cancel', offer?: CreateProposalInput) => {
    if (!proposal || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    const input = { ...offer, expectedVersion: proposal.version };
    const body = JSON.stringify({ id: proposal.id, action, input });
    if (attempt.current?.body !== body) attempt.current = { body, key: createSubmitCommandKey() };
    try {
      const result = await api.commandProposal(proposal.id, action, input, attempt.current!.key);
      setProposal(result); setEditing(false); attempt.current = null;
    } catch (cause) {
      setError(errorText(cause));
      if (cause instanceof ApiClientError && cause.statusCode < 500) {
        attempt.current = null;
        if (cause.statusCode === 409 || cause.statusCode === 403) {
          setEditing(false);
          try { setProposal(await api.getProposal(proposal.id)); } catch { setProposal(null); }
        }
      }
    } finally { locked.current = false; setBusy(false); }
  };
  const current = proposal?.versions.find(version => version.number === proposal.currentVersion);
  const participant = proposal && [proposal.initiatorId, proposal.recipientId].includes(actor);
  const responder = participant && proposal.status === 'PENDING' && proposal.responderId === actor;
  const initial = current && { offeredItemIds: current.offeredItems.map(item => item.itemId), targetItemId: current.targetItem.itemId, differenceFen: current.differenceFen, payer: current.payer, deliveryMode: current.deliveryMode, initiatorShippingFen: current.initiatorShippingFen, recipientShippingFen: current.recipientShippingFen };
  return <View>
    <Text>交换方案</Text>
    <Button {...buttonRole} disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新方案</Button>
    {error && <Text {...alertRole}>{error}</Text>}
    {!proposal ? <Text>加载方案中</Text> : <View>
      <ProposalHistory proposal={proposal} />
      {responder ? <View>
        <Text>轮到你回应</Text>
        <Button {...buttonRole} disabled={busy} onClick={() => { void run('accept'); }}>接受方案</Button>
        <Button {...buttonRole} disabled={busy} onClick={() => { void run('reject'); }}>拒绝方案</Button>
        <Button {...buttonRole} disabled={busy} onClick={() => setEditing(value => !value)}>修改方案</Button>
        {editing && initial && <ProposalForm key={proposal.version} initial={initial} targetItemId={initial.targetItemId} items={items} side={actor === proposal.initiatorId ? 'INITIATOR' : 'RECIPIENT'} busy={busy} onSubmit={offer => run('counter', offer)} />}
      </View> : proposal.status === 'PENDING' && <Text>等待对方回应</Text>}
      {participant && ['PENDING', 'CONFIRMED'].includes(proposal.status) && <Button {...buttonRole} disabled={busy} onClick={() => { void run('cancel'); }}>取消提案</Button>}
    </View>}
  </View>;
}
export default ProposalDetailPage;
