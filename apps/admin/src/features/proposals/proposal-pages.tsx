import type { ProposalView } from '@barter/contracts';
import { Alert, Card, Empty, Image, Spin, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, type ProposalReadApi } from '../../lib/api-client';
import { formatFen, formatUtc } from '../review/review-queue-page';

const labels = { PENDING: '待回应', CONFIRMED: '已确认', REJECTED: '已拒绝', CANCELLED: '已取消', EXPIRED: '已到期' };
const detailLink = (p: ProposalView) => <Link to={`/proposals/${p.id}`}>查看提案 {p.id}</Link>;
function useProposalRead<T>(load: () => Promise<T>, dependencies: unknown[]) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setValue(null); setError('');
    void load().then(result => { if (active) setValue(result); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '加载失败'); });
    return () => { active = false; };
    // The callers provide the identity of the read (client and resource ID).
  }, dependencies);
  return { value, error };
}

export function ProposalListPage({ client = apiClient }: { client?: ProposalReadApi }) {
  const { value: proposals, error } = useProposalRead(() => client.listProposals(), [client]);
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return <main className="workspace-page proposal-page">
    <Typography.Title level={1}>交换提案</Typography.Title>
    <p>仅供查询，运营不能代替用户协商</p>
    {error ? <Alert type="error" message={error} /> : !proposals ? <Spin /> : proposals.length === 0 ? <Empty description="暂无提案" /> : mobile ? <ul className="mobile-review-list" aria-label="交换提案">
      {proposals.map(p => <li key={p.id}><Card>{detailLink(p)}<p>{labels[p.status]} · 方案 {p.currentVersion}</p><p>发起方：{p.initiatorId}</p><p>接收方：{p.recipientId}</p><time>{formatUtc(p.createdAt)}</time></Card></li>)}
    </ul> : <Table rowKey="id" dataSource={proposals} pagination={{ pageSize: 20 }} columns={[
      { title: '提案', render: (_, p) => detailLink(p) },
      { title: '状态', render: (_, p) => labels[p.status] },
      { title: '发起方', dataIndex: 'initiatorId' },
      { title: '接收方', dataIndex: 'recipientId' },
      { title: '创建时间', render: (_, p) => formatUtc(p.createdAt) },
    ]} />}
  </main>;
}

export function ProposalDetailPage({ client = apiClient, proposalId }: { client?: ProposalReadApi; proposalId?: string }) {
  const params = useParams();
  const id = proposalId ?? params.proposalId ?? '';
  const { value: proposal, error } = useProposalRead(() => client.getProposal(id), [client, id]);
  return <main className="workspace-page proposal-page">
    <Link to="/proposals">返回提案列表</Link>
    <Typography.Title level={1}>提案详情</Typography.Title>
    <p>仅供查询，运营不能代替用户协商</p>
    {error ? <Alert type="error" message={error} /> : !proposal ? <Spin /> : <>
      <Card title={proposal.id}>
        <Tag>{labels[proposal.status]}</Tag>
        <dl><dt>发起方</dt><dd>{proposal.initiatorId}</dd><dt>接收方</dt><dd>{proposal.recipientId}</dd><dt>当前回应人</dt><dd>{proposal.responderId}</dd></dl>
        <p>修订 {proposal.version} · 当前方案 {proposal.currentVersion}</p>
        <p>待回应期限：{formatUtc(proposal.expiresAt)}</p>
        {proposal.reservationExpiresAt && <p>占用期限：{formatUtc(proposal.reservationExpiresAt)}</p>}
      </Card>
      {proposal.versions.map(version => <Card key={version.id} title={`方案历史 · 第 ${version.number} 版`}>
        <p>出价人：{version.authorId} · {formatUtc(version.createdAt)}</p>
        <div className="proposal-sides">{[...version.offeredItems, version.targetItem].map(item => <section key={item.itemId}>
          <h3>{item.ownerId === proposal.initiatorId ? '发起方' : '接收方'}：{item.title}</h3>
          <p>{item.description}</p><p>成色：{item.condition} · {formatFen(item.referenceValueFen)}</p><p>想换：{item.wantedText}</p>
          <div className="item-image-grid">{item.imageUrls.map((url, i) => <Image key={url} src={url} alt={`${item.title} 图片 ${i + 1}`} />)}</div>
        </section>)}</div>
        <p>差价：{formatFen(version.differenceFen)} · {version.payer === 'NONE' ? '无需补差' : version.payer === 'INITIATOR' ? '发起方补差' : '接收方补差'}</p>
        <p>{version.deliveryMode === 'IN_PERSON' ? '面交' : '快递'} · 发起方运费估计 {formatFen(version.initiatorShippingFen)} · 接收方运费估计 {formatFen(version.recipientShippingFen)}</p>
      </Card>)}
    </>}
  </main>;
}
