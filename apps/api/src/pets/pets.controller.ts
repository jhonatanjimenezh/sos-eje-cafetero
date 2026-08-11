import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OfficialGuard } from '../auth/official.guard';
import {
  CompletePetMediaDto,
  CreatePetCaseDto,
  CreatePetClaimDto,
  CreatePetProfileDto,
  PetFinderActionDto,
  PetOwnerActionDto,
  PresignPetCasePhotoDto,
  PresignPetClaimEvidenceDto,
} from './dto';
import { PetPhotoModerationDto } from './moderation.dto';
import { PetsCatalogService } from './pets-catalog.service';
import { PetsContactService } from './pets-contact.service';
import { PetsDecisionService } from './pets-decision.service';
import { PetsOriginGuard } from './pets-origin.guard';
import { PetsPhotoModerationService } from './pets-photo-moderation.service';
import { PetsPublicPhotoService } from './pets-public-photo.service';
import { PetsService } from './pets.service';

@Controller('pets')
export class PublicPetsController {
  constructor(private readonly catalog: PetsCatalogService) {}

  @Get('cases')
  list(@Query('kind') kind?: string) {
    return this.catalog.list(kind);
  }

  @Get('cases/:publicId/public')
  one(@Param('publicId') publicId: string) {
    return this.catalog.one(publicId);
  }
}

@Controller('pets')
@UseGuards(JwtAuthGuard, PetsOriginGuard)
export class PrivatePetsController {
  constructor(
    private readonly service: PetsService,
    private readonly contacts: PetsContactService,
    private readonly decisions: PetsDecisionService,
    private readonly photos: PetsPublicPhotoService,
  ) {}

  @Post('profiles')
  createProfile(@Req() req: any, @Body() dto: CreatePetProfileDto) {
    return this.service.createProfile(String(req.auth.sub), dto);
  }

  @Get('profiles/me')
  myProfiles(@Req() req: any) {
    return this.service.myProfiles(String(req.auth.sub));
  }

  @Post('cases')
  createCase(@Req() req: any, @Body() dto: CreatePetCaseDto) {
    return this.service.createCase(String(req.auth.sub), dto);
  }

  @Post('cases/:publicId/photo/presign')
  presignCasePhoto(
    @Req() req: any,
    @Param('publicId') publicId: string,
    @Body() dto: PresignPetCasePhotoDto,
  ) {
    return this.photos.presign(String(req.auth.sub), publicId, dto);
  }

  @Post('case-photo/:assetId/complete')
  completeCasePhoto(
    @Req() req: any,
    @Param('assetId') assetId: string,
    @Body() dto: CompletePetMediaDto,
  ) {
    return this.photos.complete(String(req.auth.sub), assetId, dto);
  }

  @Post('cases/:publicId/claims')
  createClaim(
    @Req() req: any,
    @Param('publicId') publicId: string,
    @Body() dto: CreatePetClaimDto,
  ) {
    return this.service.createClaim(String(req.auth.sub), publicId, dto);
  }

  @Post('claims/:claimId/challenge')
  createChallenge(@Req() req: any, @Param('claimId') claimId: string) {
    return this.service.createProofChallenge(String(req.auth.sub), claimId);
  }

  @Post('claims/:claimId/evidence/presign')
  presignClaimEvidence(
    @Req() req: any,
    @Param('claimId') claimId: string,
    @Body() dto: PresignPetClaimEvidenceDto,
  ) {
    return this.service.presignClaimEvidence(String(req.auth.sub), claimId, dto);
  }

  @Post('claim-evidence/:assetId/complete')
  completeClaimEvidence(
    @Req() req: any,
    @Param('assetId') assetId: string,
    @Body() dto: CompletePetMediaDto,
  ) {
    return this.service.completeClaimEvidence(String(req.auth.sub), assetId, dto);
  }

  @Get('owner/inbox')
  ownerInbox(@Req() req: any) {
    return this.service.ownerInbox(String(req.auth.sub));
  }

  @Get('owner/inbox/summary')
  ownerInboxSummary(@Req() req: any) {
    return this.service.ownerInboxSummary(String(req.auth.sub));
  }

  @Get('owner/inbox/:claimId/evidence')
  ownerEvidence(@Req() req: any, @Param('claimId') claimId: string) {
    return this.service.ownerEvidence(String(req.auth.sub), claimId);
  }

  @Get('owner/inbox/:claimId/finder-contact')
  ownerFinderContact(@Req() req: any, @Param('claimId') claimId: string) {
    return this.contacts.ownerGetsFinderContact(String(req.auth.sub), claimId);
  }

  @Post('owner/inbox/:claimId/action')
  ownerAction(
    @Req() req: any,
    @Param('claimId') claimId: string,
    @Body() dto: PetOwnerActionDto,
  ) {
    return this.decisions.ownerAction(String(req.auth.sub), claimId, dto.action);
  }

  @Get('claims/:claimId/contact')
  finderContact(@Req() req: any, @Param('claimId') claimId: string) {
    return this.service.finderContact(String(req.auth.sub), claimId);
  }

  @Get('finder/inbox')
  finderInbox(@Req() req: any) {
    return this.service.finderInbox(String(req.auth.sub));
  }

  @Get('finder/inbox/summary')
  finderInboxSummary(@Req() req: any) {
    return this.service.finderInboxSummary(String(req.auth.sub));
  }

  @Get('finder/inbox/:claimId/evidence')
  finderEvidence(@Req() req: any, @Param('claimId') claimId: string) {
    return this.service.finderEvidence(String(req.auth.sub), claimId);
  }

  @Post('finder/inbox/:claimId/action')
  finderAction(
    @Req() req: any,
    @Param('claimId') claimId: string,
    @Body() dto: PetFinderActionDto,
  ) {
    return this.decisions.finderAction(String(req.auth.sub), claimId, dto.action);
  }

  @Get('found-claims/:claimId/finder-contact')
  foundClaimFinderContact(@Req() req: any, @Param('claimId') claimId: string) {
    return this.service.foundClaimFinderContact(String(req.auth.sub), claimId);
  }

  @Get('finder/inbox/:claimId/owner-contact')
  foundClaimOwnerContact(@Req() req: any, @Param('claimId') claimId: string) {
    return this.service.foundClaimOwnerContact(String(req.auth.sub), claimId);
  }
}

@Controller('pets/moderation')
@UseGuards(OfficialGuard, PetsOriginGuard)
export class PetPhotoModerationController {
  constructor(private readonly moderation: PetsPhotoModerationService) {}

  @Get('photos')
  queue() {
    return this.moderation.queue();
  }

  @Get('photos/:assetId')
  view(@Req() req: any, @Param('assetId') assetId: string) {
    return this.moderation.view(String(req.auth.sub), String(req.official.id), assetId);
  }

  @Post('photos/:assetId')
  decide(
    @Req() req: any,
    @Param('assetId') assetId: string,
    @Body() dto: PetPhotoModerationDto,
  ) {
    return this.moderation.decide(
      String(req.auth.sub),
      String(req.official.id),
      assetId,
      dto.decision,
      dto.reason,
    );
  }
}
