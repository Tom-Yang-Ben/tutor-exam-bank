import os
import time
import math
import random

# 清除終端機螢幕的函式（支援 Windows 與 Mac/Linux）
def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

# 取得終端機的大小（若取得失敗則預設 80x24）
def get_terminal_size():
    try:
        columns, lines = os.get_terminal_size()
        return columns, lines
    except OSError:
        return 80, 24

def run_fireworks():
    # 煙花爆炸時使用的 ASCII 字元，由內而外或隨機渲染
    firework_chars = ['*', '.', '+', 'o', 'O', '@', '#', '%']
    
    WIDTH, HEIGHT = get_terminal_size()
    # 稍微縮小邊界，避免字元超出換行導致畫面閃爍
    WIDTH -= 1
    HEIGHT -= 2

    # 隨機決定煙花發射的起點（螢幕底部）與爆炸點（螢幕中上部）
    start_x = random.randint(int(WIDTH * 0.2), int(WIDTH * 0.8))
    explode_x = random.randint(int(WIDTH * 0.3), int(WIDTH * 0.7))
    explode_y = random.randint(int(HEIGHT * 0.2), int(HEIGHT * 0.6))

    # --- 階段 1：煙花火箭發射上升 ---
    current_x = start_x
    for y in range(HEIGHT - 1, explode_y, -1):
        # 計算一條微彎的上升弧線
        progress = (HEIGHT - 1 - y) / (HEIGHT - 1 - explode_y)
        current_x = int(start_x + (explode_x - start_x) * progress)
        
        # 繪製上升畫面
        frame = [[" " for _ in range(WIDTH)] for _ in range(HEIGHT)]
        if 0 <= current_x < WIDTH and 0 <= y < HEIGHT:
            frame[y][current_x] = "^"  # 用 '^' 代表火箭
            
        clear_screen()
        print("\n".join("".join(row) for row in frame), end="")
        time.sleep(0.04) # 控制上升速度

    # --- 階段 2：煙花爆炸綻放 ---
    # 粒子數量與爆炸半徑
    num_particles = 40
    max_radius = min(WIDTH // 4, HEIGHT // 2, 12)
    
    # 隨機挑選這次爆炸的煙花字元
    particle_char = random.choice(firework_chars)

    # 讓半徑慢慢變大
    for r in range(1, max_radius + 1):
        frame = [[" " for _ in range(WIDTH)] for _ in range(HEIGHT)]
        
        # 計算每個粒子的圓周位置
        for i in range(num_particles):
            # 將 360 度等分
            angle = (2 * math.pi / num_particles) * i
            
            # 考慮到終端機字型「高大於寬」（長方格），
            # 寬度乘上 2.2 倍，爆炸圓形看起來才會是正圓，而不是扁的椭圓。
            dx = int(r * math.cos(angle) * 2.2)
            dy = int(r * math.sin(angle))
            
            px = explode_x + dx
            py = explode_y + dy
            
            # 確保粒子在螢幕範圍內
            if 0 <= px < WIDTH and 0 <= py < HEIGHT:
                # 越往外圈，有機會混入更淡的字元
                if r == max_radius and random.random() > 0.5:
                    frame[py][px] = "."
                else:
                    frame[py][px] = particle_char
                    
        clear_screen()
        print("\n".join("".join(row) for row in frame), end="")
        # 煙花變大時速度通常會變慢
        time.sleep(0.05 + (r * 0.005)) 

    # --- 階段 3：煙花消散殘留 ---
    # 讓煙花閃爍一下然後消失
    for _ in range(2):
        clear_screen()
        # 隨機讓畫面上的一些粒子消失，製造殘影感
        for y in range(HEIGHT):
            for x in range(WIDTH):
                if frame[y][x] != " " and random.random() > 0.4:
                    frame[y][x] = " "
        print("\n".join("".join(row) for row in frame), end="")
        time.sleep(0.15)

# --- 主程式迴圈 ---
if __name__ == "__main__":
    print("即將開始播放 ASCII 絕美煙花... 按 Ctrl+C 可以結束播放。")
    time.sleep(2)
    
    try:
        while True:
            run_fireworks()
            # 煙花與煙花之間的間隔時間
            time.sleep(random.uniform(0.3, 0.8))
    except KeyboardInterrupt:
        clear_screen()
        print("\n煙花秀結束囉！感謝觀賞表演！🎆\n")