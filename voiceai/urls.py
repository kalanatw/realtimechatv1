from django.urls import path
from . import views

app_name = 'voiceai'

urlpatterns = [
    path('', views.home, name='home'),
    path('api/converse/', views.converse, name='converse'),
    path('api/converse_stream/', views.converse_stream, name='converse_stream'),
    path('api/stream_tts/', views.stream_tts, name='stream_tts'),
]