// Package waaproof 负责在 WAA_BACKEND=remote 且未显式配置 PROOF_SERVER_URL 时，
// 拉起随程序分发的 3-waa-proof-server（Node 实现），让 playground 自带 !proof 签名能力。
package waaproof

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// DefaultPort 是内置签名服务使用的本地端口，避免与外部 relay 的 18801 冲突
const DefaultPort = 18811

var (
	mu      sync.Mutex
	started *exec.Cmd
)

// Dir 返回随程序分发的签名服务目录；找不到时返回空字符串
func Dir() string {
	candidates := make([]string, 0, 4)
	if exe, err := os.Executable(); err == nil {
		base := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(base, "proof-server"))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "proof-server"))
	}
	for _, dir := range candidates {
		if entry := filepath.Join(dir, "bin", "start-proof-server.js"); fileExists(entry) {
			return dir
		}
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// Ensure 启动内置签名服务并返回其地址；已在运行则直接复用
func Ensure(ctx context.Context) (string, error) {
	mu.Lock()
	defer mu.Unlock()

	port := DefaultPort
	if raw := os.Getenv("PROOF_PORT"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			port = parsed
		}
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	if healthy(ctx, addr) {
		return "http://" + addr, nil
	}
	dir := Dir()
	if dir == "" {
		return "", fmt.Errorf("未找到内置签名服务目录 proof-server（应位于可执行文件同级）")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return "", fmt.Errorf("未找到 node，无法启动内置签名服务: %w", err)
	}

	cmd := exec.Command(node, filepath.Join("bin", "start-proof-server.js"))
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), fmt.Sprintf("PROOF_PORT=%d", port), fmt.Sprintf("PROOF_HOST=127.0.0.1"))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("启动内置签名服务: %w", err)
	}
	started = cmd

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if healthy(ctx, addr) {
			return "http://" + addr, nil
		}
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			return "", fmt.Errorf("内置签名服务提前退出")
		}
		time.Sleep(200 * time.Millisecond)
	}
	return "", fmt.Errorf("内置签名服务在 20 秒内未就绪")
}

func healthy(ctx context.Context, addr string) bool {
	dialer := net.Dialer{Timeout: 500 * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return false
	}
	_ = conn.Close()
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://" + addr + "/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode < 500
}

// Stop 结束本进程启动的签名服务
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	if started != nil && started.Process != nil {
		_ = started.Process.Kill()
		started = nil
	}
}
