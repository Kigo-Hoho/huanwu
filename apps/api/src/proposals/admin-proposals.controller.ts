import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { PrismaService } from '../database/prisma.service.js';
import { mapProposal, proposalInclude } from './proposal.mapper.js';

// Deliberately has no command routes or actor impersonation parameters.
@Controller('admin/proposals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OPERATIONS', 'REVIEWER', 'SUPER_ADMIN')
export class AdminProposalsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    return (await this.prisma.proposal.findMany({ include: proposalInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).map(mapProposal);
  }

  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    const proposal = await this.prisma.proposal.findUnique({ where: { id }, include: proposalInclude });
    if (!proposal) throw new NotFoundException({ code: 'PROPOSAL_NOT_FOUND', message: 'Proposal not found' });
    return mapProposal(proposal);
  }
}
