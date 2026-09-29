import type { ProposalView } from '@barter/contracts';
import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useState } from 'react';
import { defaultApiClient, defaultIdentityProvider } from '../../../lib/default-services';
import { alertRole, buttonRole, errorText, statusLabels } from '../shared';

export default function ProposalListPage() {
  const [direction, setDirection] = useState<'sent' | 'received'>('received');
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    void defaultApiClient.authenticate(defaultIdentityProvider).then(() => defaultApiClient.listProposals(direction)).then(values => { if (active) setProposals(values); }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [direction, refresh]);
  return <View>
    <Text>投物箱</Text>
    <Button {...buttonRole} onClick={() => setDirection('received')}>收到的投物</Button><Button {...buttonRole} onClick={() => setDirection('sent')}>发出的投物</Button>
    <Button {...buttonRole} onClick={() => setRefresh(value => value + 1)}>刷新投物箱</Button>
    {error && <Text {...alertRole}>{error}</Text>}
    {loading ? <Text>加载中</Text> : proposals.length === 0 ? <Text>暂无提案</Text> : proposals.map(proposal => <View key={proposal.id}>
      <Text>{statusLabels[proposal.status]}</Text>
      <Button {...buttonRole} onClick={() => { void Taro.navigateTo({ url: `/pages/proposals/detail/index?id=${proposal.id}` }); }}>查看 {proposal.versions.find(version => version.number === proposal.currentVersion)?.targetItem.title}</Button>
    </View>)}
  </View>;
}
