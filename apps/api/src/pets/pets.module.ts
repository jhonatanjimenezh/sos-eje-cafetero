import { Module } from '@nestjs/common';
import { PetPhotoModerationController, PrivatePetsController, PublicPetsController } from './pets.controller';
import { PetsCatalogService } from './pets-catalog.service';
import { PetsContactService } from './pets-contact.service';
import { PetsOriginGuard } from './pets-origin.guard';
import { PetsPhotoModerationService } from './pets-photo-moderation.service';
import { PetsPublicPhotoService } from './pets-public-photo.service';
import { PetsService } from './pets.service';

@Module({
  controllers: [PublicPetsController, PrivatePetsController, PetPhotoModerationController],
  providers: [
    PetsService,
    PetsCatalogService,
    PetsContactService,
    PetsPublicPhotoService,
    PetsPhotoModerationService,
    PetsOriginGuard,
  ],
  exports: [PetsService],
})
export class PetsModule {}
