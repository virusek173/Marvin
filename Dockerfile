FROM node:22.0.0-alpine
WORKDIR /usr/src/app
RUN mkdir -p src
COPY ./src/* ./src
COPY package*.json tsconfig.json ./
RUN npm install
CMD [ "npm", "run", "marvin" ]
