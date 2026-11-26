import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MetroVivo CDMX — Mapa 3D Ciudadano del Metro en Vivo",
  description:
    "Proyecto ciudadano abierto y sin fines de lucro: visualización 3D interactiva y motor cinemático del Metro CDMX con estado oficial en vivo y tiempos reales colaborativos.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#07090E",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
