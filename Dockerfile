# Frontend: compila la SPA de Vite y la sirve con nginx, que además hace de
# puerta de entrada y redirige /api al backend.

FROM node:22-alpine AS build
WORKDIR /app

# package-lock.json primero: cambiar el código de la app no debe invalidar la
# capa de npm ci, que es la lenta.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
