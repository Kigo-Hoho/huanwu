import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ItemView, ProposalView } from '@barter/contracts';
import { ProposalForm } from './proposal-form';
import { ProposalDetailPage } from './detail/index';
import { ApiClientError } from '../../lib/api-client';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item: ItemView = { id: id(1), ownerId: id(10), title: '我的咖啡机', description: '保存完好的咖啡机', referenceValueFen: 2000, condition: 'GOOD', imageUrls: [], wantedText: '', status: 'ACTIVE', version: 1, rejectReason: null, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' };
const snapshot = { ...item, itemId: item.id, itemVersion: 1 };
const proposal: ProposalView = { id: id(5), initiatorId: id(10), recipientId: id(11), responderId: id(11), status: 'PENDING', version: 3, currentVersion: 1, expiresAt: '2026-10-06T00:00:00.000Z', confirmedAt: null, reservationExpiresAt: null, createdAt: item.createdAt, updatedAt: item.updatedAt, versions: [{ id: id(6), number: 1, authorId: id(10), createdAt: item.createdAt, offeredItems: [snapshot], targetItem: { ...snapshot, itemId: id(2), ownerId: id(11), title: '对方背包' }, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }] };

describe('proposal workbench', () => {
  it('keeps initiator items fixed when recipient changes target and shipping terms', async () => {
    const submit = vi.fn();
    const current = proposal.versions[0]!;
    render(<ProposalForm items={[{ ...item, id: id(7), ownerId: id(11), title: '替换目标' }]} targetItemId={id(2)} side='RECIPIENT' initial={{ offeredItemIds: [item.id], targetItemId: id(2), differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }} onSubmit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: '选择 替换目标' }));
    fireEvent.click(screen.getByRole('button', { name: '选择快递' }));
    fireEvent.input(screen.getByLabelText('发起方运费（分）'), { target: { value: '500' } });
    fireEvent.input(screen.getByLabelText('接收方运费（分）'), { target: { value: '600' } });
    fireEvent.input(screen.getByLabelText('差价（分）'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: '接收方补差' }));
    fireEvent.click(screen.getByRole('button', { name: '提交方案' }));
    expect(submit).toHaveBeenCalledWith({ offeredItemIds: current.offeredItems.map(i => i.itemId), targetItemId: id(7), differenceFen: 200, payer: 'RECIPIENT', deliveryMode: 'COURIER', initiatorShippingFen: 500, recipientShippingFen: 600 });
    fireEvent.click(screen.getByRole('button', { name: '选择面交' }));
    fireEvent.click(screen.getByRole('button', { name: '提交方案' }));
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }));
  });

  it('refreshes after version conflict and requires the new version on the next command', async () => {
    const api = { authenticate: vi.fn(), getMe: vi.fn().mockResolvedValue({ id: id(11) }), getProposal: vi.fn().mockResolvedValueOnce(proposal).mockResolvedValue({ ...proposal, version: 4 }), listMyItems: vi.fn().mockResolvedValue([]), commandProposal: vi.fn().mockRejectedValueOnce(new ApiClientError('方案已更新', 409, { code: 'PROPOSAL_VERSION_CONFLICT' })).mockResolvedValue({ ...proposal, status: 'REJECTED', version: 5 }) };
    render(<ProposalDetailPage api={api} proposalId={proposal.id} />);
    fireEvent.click(await screen.findByRole('button', { name: '拒绝方案' }));
    await waitFor(() => expect(api.getProposal).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('方案已更新')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '拒绝方案' }));
    expect(await screen.findByText('已拒绝')).toBeVisible();
    expect(api.commandProposal.mock.calls[1]?.[2]).toEqual({ expectedVersion: 4 });
    expect(api.commandProposal.mock.calls[1]?.[3]).not.toEqual(api.commandProposal.mock.calls[0]?.[3]);
    expect(screen.queryByRole('button', { name: '取消提案' })).not.toBeInTheDocument();
  });

  it.each(['CANCELLED', 'REJECTED', 'EXPIRED'] as const)('hides every command for %s proposals', async status => {
    const api = { authenticate: vi.fn(), getMe: vi.fn().mockResolvedValue({ id: id(11) }), getProposal: vi.fn().mockResolvedValue({ ...proposal, status }), listMyItems: vi.fn().mockResolvedValue([]), commandProposal: vi.fn() };
    render(<ProposalDetailPage api={api} proposalId={proposal.id} />);
    await screen.findByText('方案历史 · 第 1 版');
    expect(screen.queryByRole('button', { name: /接受方案|拒绝方案|取消提案|修改方案/ })).not.toBeInTheDocument();
  });
  it('requires own active items and validates integer fen and maximum difference', async () => {
    const submit = vi.fn();
    render(<ProposalForm items={[item, { ...item, id: id(8), status: 'DRAFT', title: '草稿不可选' }]} targetItemId={id(2)} onSubmit={submit} />);
    expect(screen.getByRole('button', { name: '提交方案' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText('草稿不可选')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选择 我的咖啡机' }));
    expect(screen.getByRole('button', { name: '提交方案' })).toHaveAttribute('aria-disabled', 'false');
    fireEvent.input(screen.getByLabelText('差价（分）'), { target: { value: '20001' } });
    expect(screen.getByRole('button', { name: '提交方案' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.input(screen.getByLabelText('差价（分）'), { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: '提交方案' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.input(screen.getByLabelText('差价（分）'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '提交方案' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ offeredItemIds: [item.id], targetItemId: id(2), differenceFen: 0, payer: 'NONE' })));
  });

  it('shows history and responder commands with version and stable retry key', async () => {
    const commandProposal = vi.fn().mockRejectedValueOnce(new Error('网络中断')).mockResolvedValue({ ...proposal, status: 'CONFIRMED', version: 4 });
    const api = { authenticate: vi.fn(), getMe: vi.fn().mockResolvedValue({ id: id(11) }), getProposal: vi.fn().mockResolvedValue(proposal), listMyItems: vi.fn().mockResolvedValue([]), commandProposal };
    render(<ProposalDetailPage api={api} proposalId={proposal.id} />);
    fireEvent.click(await screen.findByRole('button', { name: '接受方案' }));
    expect(await screen.findByText('网络中断')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '接受方案' }));
    await waitFor(() => expect(commandProposal).toHaveBeenCalledTimes(2));
    expect(commandProposal.mock.calls[0]).toEqual(commandProposal.mock.calls[1]);
    expect(commandProposal.mock.calls[0]).toEqual([proposal.id, 'accept', { expectedVersion: 3 }, expect.any(String)]);
    expect(await screen.findByText('已确认')).toBeVisible();
    expect(screen.queryByRole('button', { name: '接受方案' })).not.toBeInTheDocument();
    expect(screen.getByText('方案历史 · 第 1 版')).toBeVisible();
  });

  it('does not offer responder actions to the waiting participant', async () => {
    const api = { authenticate: vi.fn(), getMe: vi.fn().mockResolvedValue({ id: id(10) }), getProposal: vi.fn().mockResolvedValue(proposal), listMyItems: vi.fn().mockResolvedValue([]), commandProposal: vi.fn() };
    render(<ProposalDetailPage api={api} proposalId={proposal.id} />);
    expect(await screen.findByText('等待对方回应')).toBeVisible();
    expect(screen.queryByRole('button', { name: '接受方案' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消提案' })).toBeVisible();
  });
});
