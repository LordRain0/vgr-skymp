FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o voice-agent .

FROM alpine:3.20
RUN apk --no-cache add ca-certificates
COPY --from=builder /app/voice-agent /usr/local/bin/voice-agent
ENTRYPOINT ["voice-agent"]
