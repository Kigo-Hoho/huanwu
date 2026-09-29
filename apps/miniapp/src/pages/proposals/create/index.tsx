import type { CreateProposalInput, ItemView, PublicItemView } from '@barter/contracts';
import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../../../lib/api-client';
import { createSubmitCommandKey, defaultApiClient, defaultIdentityProvider } from '../../../lib/default-services';
import { ProposalForm } from '../proposal-form';
import { alertRole, errorText } from '../shared';

export default function CreateProposalPage() {
  const targetId = Taro.getCurrentInstance().router?.params.targetId ?? '';
  const [target, setTarget] = useState<PublicItemView | null>(null);
  const [items, setItems] = useState<ItemView[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      await defaultApiClient.authenticate(defaultIdentityProvider);
      const [me, item, own] = await Promise.all([defaultApiClient.getMe(), defaultApiClient.getPublicItem(targetId), defaultApiClient.listMyItems()]);
      if (item.ownerId === me.id) throw new Error('不能向自己的物品投物');
      if (!item.availableForProposal) throw new Error('这件物品暂不可投');
      if (active) { setTarget(item); setItems(own); }
    })().catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [targetId]);
  const submit = async (input: CreateProposalInput) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: createSubmitCommandKey() };
    try {
      const proposal = await defaultApiClient.createProposal(input, attempt.current!.key);
      await Taro.redirectTo({ url: `/pages/proposals/detail/index?id=${proposal.id}` });
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.statusCode < 500) attempt.current = null;
      setError(errorText(cause));
    } finally { locked.current = false; setBusy(false); }
  };
  return <View><Text>发起投物</Text>{error && <Text {...alertRole}>{error}</Text>}{target ? <View><Text>目标：{target.title}</Text><ProposalForm items={items} targetItemId={target.id} busy={busy} onSubmit={submit} /></View> : !error && <Text>加载中</Text>}</View>;
}
