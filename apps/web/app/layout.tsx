import type { Metadata } from 'next';
import '@aws-amplify/ui-react/styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './globals.css';
import PwaBootstrap from './components/PwaBootstrap';

export const metadata: Metadata = {
  title: 'SOS Eje Cafetero',
  description: 'Centro unificado de respuesta a emergencias',
  manifest: '/manifest.webmanifest',
  applicationName: 'SOS Eje Cafetero',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <PwaBootstrap />
        {children}
      </body>
    </html>
  );
}
