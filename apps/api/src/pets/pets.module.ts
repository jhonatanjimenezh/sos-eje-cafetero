import { Module } from '@nestjs/common';
import { PrivatePetsController, PublicPetsController } from './pets.controller';
import { PetsContactService } from './pets-contact.service';
import { PetsOriginGuard } from './pets-origin.guard';
import { PetsPublicPhotoService } from './pets-public-photo.service';
import { PetsService } from './pets.service';

@Module({
  controllers: [PublicPetsController, PrivatePetsController],
  providers: [PetsService, PetsContactService, PetsPublicPhotoService, PetsOriginGuard],
  exports: [PetsService],
})
export class PetsModule {}
