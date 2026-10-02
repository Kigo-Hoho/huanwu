import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ProposalListPage, ProposalDetailPage } from './proposal-pages';
import type { ProposalView } from '@barter/contracts';

const proposal: ProposalView = { id: 'proposal-1', initiatorId: 'user-a', recipientId: 'user-b', responderId: 'user-b', status: 'PENDING', version: 1, currentVersion: 1, expiresAt: '2026-10-06T00:00:00.000Z', confirmedAt: null, reservationExpiresAt: null, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', versions: [] };
describe('operator proposal reads', () => {
  it('displays converted proposals as read-only order history', async () => {
    const converted: ProposalView = { ...proposal, status: 'CONVERTED', orderId: 'order-1' };
    const client = { listProposals: vi.fn().mockResolvedValue([converted]), getProposal: vi.fn().mockResolvedValue(converted) };
    const view = render(<MemoryRouter><ProposalListPage client={client} /></MemoryRouter>);
    expect(await screen.findByText('已转换为订单')).toBeVisible();
    view.unmount();
    render(<MemoryRouter><ProposalDetailPage client={client} proposalId={converted.id} /></MemoryRouter>);
    expect(await screen.findByText('已转换为订单')).toBeVisible();
    expect(screen.queryByRole('button', { name: /接受|拒绝|取消|修改/ })).not.toBeInTheDocument();
  });
  it('shows a mobile list and readonly detail without command buttons', async () => {
    window.innerWidth = 390;
    const client = { listProposals: vi.fn().mockResolvedValue([proposal]), getProposal: vi.fn().mockResolvedValue(proposal) };
    const view = render(<MemoryRouter><ProposalListPage client={client} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: '查看提案 proposal-1' })).toBeVisible();
    expect(screen.getByRole('list', { name: '交换提案' })).toBeVisible();
    view.unmount();
    render(<MemoryRouter><ProposalDetailPage client={client} proposalId={proposal.id} /></MemoryRouter>);
    expect(await screen.findByText('user-a')).toBeVisible();
    expect(screen.getByText('仅供查询，运营不能代替用户协商')).toBeVisible();
    expect(screen.queryByRole('button', { name: /接受|拒绝|取消|修改/ })).not.toBeInTheDocument();
  });
});
