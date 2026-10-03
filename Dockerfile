FROM node:22.0.0-alpine
ENV TZ=Europe/Warsaw
WORKDIR /usr/src/app
RUN mkdir -p src
COPY ./src ./src
COPY package*.json tsconfig.json ./
RUN npm install
CMD [ "npm", "run", "marvin" ]
