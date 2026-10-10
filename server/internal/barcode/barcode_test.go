package barcode

import (
	"errors"
	"testing"
	"time"

	"github.com/kiddyt00/sdy/server/internal/pricing"
	"github.com/kiddyt00/sdy/server/internal/store"
)

func newStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:", pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// fakeCloud 记录调用次数，便于断言「本地命中不消耗云端配额」。
type fakeCloud struct {
	calls int
	item  CloudItem
	found bool
	err   error
}

func (f *fakeCloud) fn() CloudFunc {
	return func(code string) (CloudItem, bool, error) {
		f.calls++
		return f.item, f.found, f.err
	}
}

func TestResolveProductFirst(t *testing.T) {
	st := newStore(t)
	if _, err := st.UpsertProduct(store.Product{Code: "6901", Name: "可乐", Spec: "330ml", Stock: 10}); err != nil {
		t.Fatal(err)
	}
	fc := &fakeCloud{item: CloudItem{Name: "云端可乐"}, found: true}
	r := New(st, DefaultConfig(), fc.fn())

	got, err := r.Resolve(" 6901 ") // 前后空格应被清理
	if err != nil {
		t.Fatal(err)
	}
	if !got.Found || got.Source != "product" || got.Name != "可乐" {
		t.Errorf("期望命中商品档案层，实际 %+v", got)
	}
	if fc.calls != 0 {
		t.Errorf("本地命中不应调用云端，实际调用 %d 次", fc.calls)
	}
}

func TestResolveLibSecond(t *testing.T) {
	st := newStore(t)
	if err := st.UpsertLib(store.LibEntry{Code: "6902", Name: "东方树叶", Spec: "500ml", Source: "lib", Status: "found"}); err != nil {
		t.Fatal(err)
	}
	fc := &fakeCloud{item: CloudItem{Name: "云端"}, found: true}
	r := New(st, DefaultConfig(), fc.fn())

	got, _ := r.Resolve("6902")
	if !got.Found || got.Source != "lib" || got.Name != "东方树叶" {
		t.Errorf("期望命中字典层，实际 %+v", got)
	}
	if fc.calls != 0 {
		t.Errorf("字典命中不应调用云端，实际 %d 次", fc.calls)
	}
	if e, _ := st.GetLib("6902"); e.Hits != 1 {
		t.Errorf("命中次数期望 1，实际 %d", e.Hits)
	}
}

func TestResolveCloudBackfill(t *testing.T) {
	st := newStore(t)
	fc := &fakeCloud{item: CloudItem{Name: "康师傅红烧牛肉面", Spec: "103g"}, found: true}
	r := New(st, DefaultConfig(), fc.fn())

	got, _ := r.Resolve("6903")
	if !got.Found || got.Source != "cloud" || got.Name != "康师傅红烧牛肉面" {
		t.Fatalf("期望云端命中，实际 %+v", got)
	}
	if fc.calls != 1 {
		t.Fatalf("云端调用期望 1 次，实际 %d", fc.calls)
	}
	e, ok := st.GetLib("6903")
	if !ok || e.Status != "found" || e.Source != "cloud" {
		t.Errorf("云端结果未永久回填字典层: %+v ok=%v", e, ok)
	}
	// 第二次同码：本地字典命中，不再消耗配额
	again, _ := r.Resolve("6903")
	if again.Source != "lib" {
		t.Errorf("回填后应命中字典层，实际 %s", again.Source)
	}
	if fc.calls != 1 {
		t.Errorf("二次解析不应再调云端，实际 %d 次", fc.calls)
	}
}

func TestResolveCloudNotFoundTTL(t *testing.T) {
	st := newStore(t)
	now := time.Date(2026, 10, 10, 10, 0, 0, 0, time.Local)
	fc := &fakeCloud{found: false}
	r := New(st, DefaultConfig(), fc.fn())
	r.SetClock(func() time.Time { return now })

	got, _ := r.Resolve("6900000000000")
	if got.Found || got.Source != "not_found" {
		t.Fatalf("期望查无，实际 %+v", got)
	}
	e, ok := st.GetLib("6900000000000")
	if !ok || e.Status != "not_found" {
		t.Fatalf("未写入 not_found 标记: %+v ok=%v", e, ok)
	}
	want := now.AddDate(0, 0, 90).Format(time.RFC3339)
	if e.ExpiresAt != want {
		t.Errorf("TTL 期望 %s，实际 %s", want, e.ExpiresAt)
	}
	if got.ExpiresAt != want {
		t.Errorf("结果应带查无到期时间供前端算剩余天数，期望 %s，实际 %q", want, got.ExpiresAt)
	}
	// TTL 内再扫：直接返回查无，不消耗配额
	again, _ := r.Resolve("6900000000000")
	if again.Source != "not_found" || fc.calls != 1 {
		t.Errorf("TTL 内应本地返回查无，实际 source=%s calls=%d", again.Source, fc.calls)
	}
	if again.ExpiresAt == "" {
		t.Errorf("本地 not_found 命中也要带 expiresAt")
	}
	// TTL 过期后重新查云端
	now = now.AddDate(0, 0, 91)
	third, _ := r.Resolve("6900000000000")
	if third.Source != "not_found" || fc.calls != 2 {
		t.Errorf("TTL 过期后应重查云端，实际 source=%s calls=%d", third.Source, fc.calls)
	}
}

func TestResolveCircuitBreaker(t *testing.T) {
	st := newStore(t)
	now := time.Date(2026, 10, 10, 9, 0, 0, 0, time.Local)
	fc := &fakeCloud{found: true, item: CloudItem{Name: "某商品"}}
	fc.err = errors.New("云端 HTTP 500（400参数/401鉴权/429限流/5xx故障）")
	r := New(st, DefaultConfig(), fc.fn())
	r.SetClock(func() time.Time { return now })

	for i := 0; i < 5; i++ {
		got, _ := r.Resolve("690000000000" + string(rune('1'+i)))
		if got.Source != "cloud_error" {
			t.Fatalf("第 %d 次期望 cloud_error，实际 %s", i+1, got.Source)
		}
	}
	if !r.CircuitOpen() {
		t.Fatal("连续 5 次失败后应熔断")
	}
	// 熔断期间不再调云端
	before := fc.calls
	got, _ := r.Resolve("6909999999999")
	if got.Source != "blocked" || fc.calls != before {
		t.Errorf("熔断期间应直接返回 blocked 且不调云端，实际 source=%s calls=%d", got.Source, fc.calls)
	}
	// 次日恢复
	now = now.AddDate(0, 0, 1)
	fc.err = nil
	got, _ = r.Resolve("6909999999999")
	if got.Source != "cloud" || !got.Found {
		t.Errorf("次日应恢复云端查询，实际 %+v", got)
	}
}

func TestResolveEdgeCases(t *testing.T) {
	st := newStore(t)
	r := New(st, DefaultConfig(), nil) // 纯本地模式

	if _, err := r.Resolve("  "); !errors.Is(err, store.ErrBadInput) {
		t.Error("空条码应返回 ErrBadInput")
	}
	got, err := r.Resolve("6905")
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != "cloud_error" || got.Error == "" {
		t.Errorf("未配置云端时应有明确提示，实际 %+v", got)
	}
}
